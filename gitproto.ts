// Git smart HTTP: info/refs advertisements (protocol v0 and v2), ls-refs,
// fetch (v0 and v2, with shallow support) and receive-pack with per-ref
// report-status. Implemented from the protocol itself on the object store;
// no git binary is involved on either side of the wire.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRepo, isoNow, type Repo } from './forge.ts';
import {
  ZERO_SHA, commitDepths, getObject, isAncestor, parseCommit, parseTree, peelToCommit, reachableFrom,
} from './gitstore.ts';
import { PKT_DELIM, PKT_FLUSH, PKT_RESPONSE_END, PktReader, buildPack, parsePack, pktLine } from './pack.ts';
import { badCredentials, notFound, readBody, sendBuffer } from './webutil.ts';

const AGENT = 'makefun-forge/1.0';
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function tokenOk(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return false;
  return req.headers.authorization === `Bearer ${SHOP_TOKEN}`;
}

function tokenPresent(req: IncomingMessage): boolean {
  return typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;
}

// ------------------------------------------------------------ ref listing ---

interface RefLine {
  sha: string;
  name: string;
  peeled?: string;
}

/** HEAD first (when it has a target), then every ref sorted by name, tags peeled. */
function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const sha = repo.refs.get(name) as string;
    const line: RefLine = { sha, name };
    const obj = getObject(sha);
    if (obj && obj.type === 'tag') {
      const commit = peelToCommit(sha);
      if (commit) line.peeled = commit;
    }
    lines.push(line);
  }
  return lines;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ------------------------------------------------------------ advertisement ---

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  const headSha = repo.refs.get(headTarget(repo));
  if (!headSha && refs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headSha ?? ZERO_SHA} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.sha} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  const parts = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ fetch logic ---

interface FetchPlan {
  packShas: string[];
  shallow: string[];
  unshallow: string[];
}

/** A commit plus the closure of its own tree (trees and blobs, no parents). */
function commitClosure(sha: string, into: Set<string>): void {
  into.add(sha);
  const obj = getObject(sha);
  if (obj?.type !== 'commit') return;
  const stack = [parseCommit(obj.data).tree];
  while (stack.length > 0) {
    const treeSha = stack.pop() as string;
    if (into.has(treeSha)) continue;
    const treeObj = getObject(treeSha);
    if (!treeObj || treeObj.type !== 'tree') continue;
    into.add(treeSha);
    for (const entry of parseTree(treeObj.data)) {
      into.add(entry.sha);
      if (entry.mode === '40000') stack.push(entry.sha);
    }
  }
}

function planFetch(repo: Repo, wants: string[], haves: string[], deepen: number, deepenRelative: number, clientShallow: string[], includeTag = false): FetchPlan {
  const wantCommits = wants.map((w) => peelToCommit(w) ?? w).filter((w) => getObject(w)?.type === 'commit');
  const haveSet = new Set<string>();
  const shallowHaves = new Set(clientShallow);
  if (clientShallow.length > 0) {
    // The client's knowledge stops at its shallow boundary: walk the haves
    // adding each commit's own closure, but never cross a boundary commit
    // into its parents.
    const queue: string[] = [];
    const seenCommits = new Set<string>();
    for (const have of haves) {
      if (getObject(have)?.type === 'commit') queue.push(have);
      else if (getObject(have)) haveSet.add(have);
    }
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (seenCommits.has(sha)) continue;
      seenCommits.add(sha);
      commitClosure(sha, haveSet);
      if (shallowHaves.has(sha)) continue;
      const obj = getObject(sha);
      if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
  } else {
    for (const have of haves) {
      if (getObject(have)?.type === 'commit') {
        for (const sha of reachableFrom([have])) haveSet.add(sha);
      } else if (getObject(have)) {
        haveSet.add(have);
      }
    }
  }
  // With include-tag, tag objects whose target is being sent ride along.
  const withTags = (include: Set<string>): Set<string> => {
    if (!includeTag) return include;
    const out = new Set(include);
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/tags/')) continue;
      const target = peelToCommit(sha);
      if (target && out.has(target)) {
        for (const extra of reachableFrom([sha])) out.add(extra);
      }
    }
    return out;
  };

  let depthLimit = deepen;
  if (deepenRelative > 0) {
    // Extend the client's existing shallow boundary by N generations.
    let base = 0;
    for (const tip of wantCommits) {
      const depths = commitDepths(tip);
      for (const shallowSha of clientShallow) {
        const d = depths.get(shallowSha);
        if (d !== undefined && d > base) base = d;
      }
    }
    depthLimit = base + deepenRelative;
  }

  if (depthLimit <= 0) {
    const include = withTags(reachableFrom(wants));
    const packShas = [...include].filter((sha) => !haveSet.has(sha));
    // A previously shallow commit the client now receives in full history is
    // unshallowed when it is reachable and no longer at a boundary.
    return { packShas, shallow: [], unshallow: clientShallow.filter((s) => include.has(s)) };
  }

  const depthOf = new Map<string, number>();
  for (const tip of wantCommits) {
    for (const [sha, d] of commitDepths(tip, depthLimit)) {
      if (!depthOf.has(sha) || d < (depthOf.get(sha) as number)) depthOf.set(sha, d);
    }
  }
  const includedCommits = [...depthOf.entries()].filter(([, d]) => d <= depthLimit).map(([sha]) => sha);
  // A shallow pack carries each included commit plus its own tree closure —
  // the trees and blobs of that commit only, never its ancestors' objects.
  const shallowInclude = new Set<string>();
  for (const sha of includedCommits) commitClosure(sha, shallowInclude);
  const include = withTags(shallowInclude);
  const boundary: string[] = [];
  for (const sha of includedCommits) {
    // A commit is a shallow boundary when it sits exactly at the depth limit
    // and has parents the limit cut off; a root commit there ends the
    // history naturally and is not a boundary.
    if ((depthOf.get(sha) as number) !== depthLimit) continue;
    const obj = getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    const parents = (obj.data.toString('utf8').split('\n\n')[0] ?? '')
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice(7).trim());
    if (parents.length > 0) boundary.push(sha);
  }
  const packShas = [...include].filter((sha) => !haveSet.has(sha));
  const unshallow = clientShallow.filter((s) => depthOf.has(s) && (depthOf.get(s) as number) < depthLimit);
  return { packShas, shallow: boundary, unshallow };
}

/** Frame a pack in sideband band 1, optionally with a progress line. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function sortPackOrder(shas: string[]): string[] {
  const rank = (sha: string): number => {
    const type = getObject(sha)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3;
  };
  return [...shas].sort((a, b) => rank(a) - rank(b));
}

// ------------------------------------------------------------- v2 commands ---

async function handleV2(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const reader = new PktReader(body);
  const headerLines: string[] = [];
  let pkt = reader.next();
  while (pkt && pkt.kind === 'data') {
    headerLines.push(pkt.data.toString('utf8').replace(/\n$/, ''));
    pkt = reader.next();
  }
  const command = headerLines.find((line) => line.startsWith('command='))?.slice('command='.length);
  const args: string[] = [];
  if (pkt && pkt.kind === 'delim') {
    pkt = reader.next();
    while (pkt && pkt.kind === 'data') {
      args.push(pkt.data.toString('utf8').replace(/\n$/, ''));
      pkt = reader.next();
    }
  }

  if (command === 'ls-refs') {
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const unborn = args.includes('unborn');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: Buffer[] = [];
    const target = headTarget(repo);
    const headSha = repo.refs.get(target);
    if (matches('HEAD')) {
      if (headSha) {
        out.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
      } else if (unborn) {
        out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
      }
    }
    for (const ref of listRefs(repo)) {
      if (!matches(ref.name)) continue;
      const extra = peel && ref.peeled ? ` peeled:${ref.peeled}` : '';
      out.push(pktLine(`${ref.sha} ${ref.name}${extra}\n`));
    }
    out.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    const wantRefs: string[] = [];
    let deepen = 0;
    let deepenRelative = 0;
    let done = false;
    let includeTag = false;
    const acks: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7), 10) || 0;
      else if (arg.startsWith('deepen-relative ')) deepenRelative = Number.parseInt(arg.slice('deepen-relative '.length), 10) || 0;
      else if (arg.startsWith('want-ref ')) wantRefs.push(arg.slice('want-ref '.length).trim());
      else if (arg === 'include-tag') includeTag = true;
      else if (arg === 'done') done = true;
    }

    for (const have of haves) {
      if (getObject(have)?.type === 'commit') acks.push(`ACK ${have}\n`);
    }

    const parts: Buffer[] = [];

    if (!done) {
      // A negotiation-style request (wants and haves, no done): over this
      // stateless transport the whole fetch is answered in one response —
      // the acknowledgments section first, then the packfile sections, as a
      // server that is ready does.
      parts.push(pktLine('acknowledgments\n'));
      if (acks.length === 0) parts.push(pktLine('NAK\n'));
      else for (const ack of acks) parts.push(pktLine(ack));
      parts.push(pktLine('ready\n'), PKT_DELIM);
    }

    const plan = planFetch(repo, wants, haves, deepen, deepenRelative, clientShallow, includeTag);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0 || deepen > 0 || deepenRelative > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
    if (wantRefs.length > 0) {
      parts.push(pktLine('wanted-refs\n'));
      for (const ref of wantRefs) {
        const sha = repo.refs.get(ref);
        if (sha) parts.push(pktLine(`${sha} ${ref}\n`));
      }
      parts.push(PKT_DELIM);
    }
    // The packfile section carries its sideband stream directly after the
    // header — no delim — and the stream's own flush closes the response.
    parts.push(pktLine('packfile\n'));
    const pack = buildPack(sortPackOrder(plan.packShas));
    parts.push(sidebandPack(pack));
    sendBuffer(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  sendBuffer(res, 400, pktLine('ERR unknown command\n'), { 'content-type': 'application/x-git-upload-pack-result' });
}

// ------------------------------------------------------------- v0 upload ---

async function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen = 0;
  let sideband = false;
  let includeTag = false;
  let sawDone = false;
  let pkt = reader.next();
  while (pkt) {
    if (pkt.kind === 'data') {
      const line = pkt.data.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const sha = rest.slice(0, 40);
        wants.push(sha);
        const caps = rest.slice(40).trim();
        if (caps.includes('side-band-64k') || caps.includes('side-band')) sideband = true;
        if (caps.includes('include-tag')) includeTag = true;
      } else if (line.startsWith('have ')) haves.push(line.slice(5, 45).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10) || 0;
      else if (line === 'done') { sawDone = true; break; }
    }
    pkt = reader.next();
  }
  void sawDone;

  const plan = planFetch(repo, wants, haves, deepen, 0, clientShallow, includeTag);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = buildPack(sortPackOrder(plan.packShas));
  if (sideband) parts.push(sidebandPack(pack));
  else {
    parts.push(pack);
  }
  sendBuffer(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
}

// ------------------------------------------------------------- receive -----

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const reader = new PktReader(body);
  const updates: RefUpdate[] = [];
  let caps = '';
  let pkt = reader.next();
  while (pkt && pkt.kind === 'data') {
    let line = pkt.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length >= 3) updates.push({ oldSha: fields[0], newSha: fields[1], ref: fields[2] });
    pkt = reader.next();
  }
  const packData = reader.rest();
  const reportStatus = caps.includes('report-status');
  const sideband = caps.includes('side-band-64k') || caps.includes('side-band');

  let unpackError: string | undefined;
  if (packData.length > 0) {
    try {
      await parsePack(packData);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const update of updates) {
    const fail = (reason: string) => results.push({ ref: update.ref, ok: false, reason });
    if (unpackError) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(update.ref);
    if (update.newSha === ZERO_SHA) {
      // A deletion.
      if (current === undefined) { fail('reference not found'); continue; }
      if (update.oldSha !== ZERO_SHA && current !== update.oldSha) { fail('stale info'); continue; }
      if (update.ref === headTarget(repo)) { fail('deletion of the current branch prohibited'); continue; }
      repo.refs.delete(update.ref);
      results.push({ ref: update.ref, ok: true });
      continue;
    }
    const newObj = getObject(update.newSha);
    if (!newObj) { fail('new object not found'); continue; }
    if (update.oldSha === ZERO_SHA) {
      if (current !== undefined) { fail('reference already exists'); continue; }
      if (update.ref.startsWith('refs/heads/') && newObj.type !== 'commit' && newObj.type !== 'tag') { fail('branch must point to a commit'); continue; }
      repo.refs.set(update.ref, update.newSha);
      results.push({ ref: update.ref, ok: true });
      continue;
    }
    if (current === undefined) { fail('reference not found'); continue; }
    if (current !== update.oldSha) { fail('stale info'); continue; }
    const newCommit = peelToCommit(update.newSha);
    const oldCommit = peelToCommit(update.oldSha);
    if (!newCommit || !oldCommit || !isAncestor(oldCommit, newCommit)) { fail('non-fast-forward'); continue; }
    repo.refs.set(update.ref, update.newSha);
    results.push({ ref: update.ref, ok: true });
  }
  repo.updatedAt = isoNow();

  if (!reportStatus) {
    sendBuffer(res, 200, Buffer.alloc(0), { 'content-type': 'application/x-git-receive-pack-result' });
    return;
  }
  const lines: Buffer[] = [];
  lines.push(pktLine(unpackError ? `unpack error: ${unpackError}\n` : 'unpack ok\n'));
  for (const result of results) {
    lines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  lines.push(PKT_FLUSH);
  const report = Buffer.concat(lines);
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < report.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, Math.min(report.length, at + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-receive-pack-result' });
  } else {
    sendBuffer(res, 200, report, { 'content-type': 'application/x-git-receive-pack-result' });
  }
}

// ---------------------------------------------------------------- routing ---

/** Handle every route under /{owner}/{repo}.git. Returns false when not a git route. */
export async function handleGitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
): Promise<boolean> {
  const service = query.get('service');
  const isInfoRefs = sub === '/info/refs';
  const isUpload = sub === '/git-upload-pack';
  const isReceive = sub === '/git-receive-pack';
  if (!isInfoRefs && !isUpload && !isReceive) return false;

  const authed = tokenOk(req);
  if (!authed && tokenPresent(req)) {
    badCredentials(res);
    return true;
  }
  const repo = getRepo(owner, repoName);
  if (!repo) {
    notFound(res);
    return true;
  }
  if ((isReceive || (isInfoRefs && service === 'git-receive-pack')) && !authed) {
    badCredentials(res);
    return true;
  }

  if (isInfoRefs) {
    const wantsV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (service === 'git-upload-pack') {
      const body = wantsV2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack');
      sendBuffer(res, 200, body, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'cache-control': 'no-cache, max-age=0, must-revalidate',
      });
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = advertiseV0(repo, 'git-receive-pack');
      sendBuffer(res, 200, body, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'cache-control': 'no-cache, max-age=0, must-revalidate',
      });
      return true;
    }
    notFound(res);
    return true;
  }

  if (isUpload) {
    const wantsV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    if (wantsV2) await handleV2(req, res, repo);
    else await handleUploadPackV0(req, res, repo);
    return true;
  }

  await handleReceivePack(req, res, repo);
  return true;
}
