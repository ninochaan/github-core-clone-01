// The forge's git core: a content-addressed object store with refs, in memory.
//
// Objects (blob/tree/commit/tag) are keyed by their git SHA-1 and shared by
// every repository, the way a real forge's storage layer deduplicates by
// content. Repositories own only their refs, their HEAD and their metadata;
// deleting a repository drops its refs, and its API surface goes dark even
// though unreachable objects linger in the store, invisible to every route.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_SHA = '0000000000000000000000000000000000000000';

const objects = new Map<string, GitObject>();

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

export function getObject(sha: string): GitObject | undefined {
  return objects.get(sha);
}

export function hasObject(sha: string): boolean {
  return objects.has(sha);
}

// ------------------------------------------------------------------ trees ---

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Read a whole tree recursively into a flat path -> blob entry map. */
export function flattenTree(treeSha: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = getObject(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.sha, path, out);
    else out.set(path, entry);
  }
  return out;
}

/** Write a tree (and its subtrees) from a flat path -> {mode, sha} map. */
export function buildTree(files: Map<string, { mode: string; sha: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!dir.dirs.has(parts[i])) dir.dirs.set(parts[i], { files: new Map(), dirs: new Map() });
      dir = dir.dirs.get(parts[i]) as Dir;
    }
    dir.files.set(parts[parts.length - 1], file);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: write(sub) });
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, sha: file.sha });
    return storeObject('tree', serializeTree(entries));
  };
  return write(root);
}

// ---------------------------------------------------------------- commits ---

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const commit: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export function serializeCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** Split an ident line "Name <email> 1700000000 +0000" into its parts. */
export function parseIdent(ident: string): { name: string; email: string; date: Date } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident.trim());
  if (!match) return { name: ident.trim(), email: '', date: new Date(0) };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000) };
}

export function formatIdent(name: string, email: string, when: Date): string {
  const seconds = Math.floor(when.getTime() / 1000);
  return `${name} <${email}> ${seconds} +0000`;
}

// ------------------------------------------------------------------- tags ---

export interface Tag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const tag: Tag = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

/** Peel a ref target to the commit it ultimately names (through tags). */
export function peelToCommit(sha: string): string | undefined {
  let current = sha;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = getObject(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// -------------------------------------------------------------- traversal ---

/** Every object reachable from the given tips (commits, trees, blobs, tags). */
export function reachableFrom(tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = getObject(sha);
    if (!obj) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Commits reachable from `tip`, newest first (BFS by generation). */
export function commitHistory(tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    const obj = getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(sha);
    out.push(sha);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

/** A best common ancestor of two commits, or undefined when unrelated. */
export function mergeBase(a: string, b: string): string | undefined {
  const ancestorsOfA = new Set(commitHistory(a, 100000));
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const obj = getObject(sha);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return undefined;
}

/**
 * Depth (in commits) of every commit reachable from `tip`, following parents.
 * Used for shallow fetch: a commit's depth is 1 + max(parent depths), with the
 * tip at depth 1, matching the client's expectation for --depth N.
 */
export function commitDepths(tip: string, maxDepth = Number.POSITIVE_INFINITY): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 1]];
  let head = 0;
  while (head < queue.length) {
    const [sha, depth] = queue[head++] as [string, number];
    if (depths.has(sha) && (depths.get(sha) as number) <= depth) continue;
    depths.set(sha, depth);
    if (depth >= maxDepth) continue;
    const obj = getObject(sha);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, depth + 1]);
    }
  }
  return depths;
}
