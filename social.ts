// The social layer of REST v3: labels, issues, issue comments and pull
// requests, including three-way merges. Issues and pull requests share one
// number sequence per repository, as they do on GitHub, and a pull request
// also appears in the issues view with a pull_request marker.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER, branchRef, globalId, isoNow, userByLogin, type Issue, type Label, type PullRequest, type Repo,
} from './forge.ts';
import {
  buildTree, commitHistory, flattenTree, formatIdent, getObject, isAncestor, mergeBase, parseCommit,
  serializeCommit, storeObject, type TreeEntry,
} from './gitstore.ts';
import { diffText } from './diff.ts';
import { baseUrl, nodeId, pageOf, paginate, repoJson, userJson, validationFailed } from './restutil.ts';
import { notFound, requestId, sendJson } from './webutil.ts';

// ------------------------------------------------------------------ shapes ---

export function labelJson(req: IncomingMessage, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: label.isDefault,
  };
}

export function issueJson(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = baseUrl(req);
  const apiBase = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const user = userByLogin(issue.userLogin) ?? VIEWER;
  const json: Record<string, unknown> = {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: `${apiBase}/issues/${issue.number}`,
    repository_url: apiBase,
    labels_url: `${apiBase}/issues/${issue.number}/labels{/name}`,
    comments_url: `${apiBase}/issues/${issue.number}/comments`,
    events_url: `${apiBase}/issues/${issue.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(req, user),
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map((label) => labelJson(req, repo, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
  if (issue.isPullRequest) {
    json.pull_request = {
      url: `${apiBase}/pulls/${issue.number}`,
      html_url: `${base}/${repo.owner}/${repo.name}/pull/${issue.number}`,
      diff_url: `${base}/${repo.owner}/${repo.name}/pull/${issue.number}.diff`,
      patch_url: `${base}/${repo.owner}/${repo.name}/pull/${issue.number}.patch`,
    };
  }
  return json;
}

function refObject(req: IncomingMessage, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(req, VIEWER),
    repo: repoJson(req, repo),
  };
}

export interface PrFile {
  sha: string;
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** The three-dot file diff of a pull request: merge-base tree vs head tree. */
export function prFiles(repo: Repo, pull: PullRequest): PrFile[] {
  const base = mergeBase(pull.baseSha, pull.headSha) ?? pull.baseSha;
  const baseCommit = getObject(base);
  const headCommit = getObject(pull.headSha);
  if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return [];
  const baseFiles = flattenTree(parseCommit(baseCommit.data).tree);
  const headFiles = flattenTree(parseCommit(headCommit.data).tree);
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const files: PrFile[] = [];
  for (const path of paths) {
    const before: TreeEntry | undefined = baseFiles.get(path);
    const after: TreeEntry | undefined = headFiles.get(path);
    if (before && after && before.sha === after.sha && before.mode === after.mode) continue;
    const oldText = before ? (getObject(before.sha)?.data.toString('utf8') ?? '') : '';
    const newText = after ? (getObject(after.sha)?.data.toString('utf8') ?? '') : '';
    const diff = diffText(oldText, newText);
    files.push({
      sha: after?.sha ?? before?.sha ?? '',
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      patch: diff.patch === '' ? undefined : diff.patch,
    });
  }
  return files;
}

export function pullJson(req: IncomingMessage, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const base = baseUrl(req);
  const apiBase = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const files = prFiles(repo, pull);
  const headHistory = commitHistory(pull.headSha, 100000);
  const commits = headHistory.filter((sha) => !isAncestor(sha, pull.baseSha)).length;
  const user = userByLogin(pull.userLogin) ?? VIEWER;
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    url: `${apiBase}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${apiBase}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(req, user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: pull.draft,
    head: refObject(req, repo, pull.headRef, pull.headSha),
    base: refObject(req, repo, pull.baseRef, pull.baseSha),
    author_association: 'OWNER',
    merged: pull.merged,
    mergeable: null,
    comments: repo.issues.get(pull.number)?.comments.length ?? 0,
    review_comments: 0,
    commits,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changed_files: files.length,
  };
}

// ----------------------------------------------------------------- merges ---

export interface MergeOutcome {
  sha: string;
}

/** Three-way tree merge; returns the merged tree sha, or undefined on conflict. */
function mergeTrees(baseSha: string, oursSha: string, theirsSha: string): string | undefined {
  const baseCommit = getObject(baseSha);
  const oursCommit = getObject(oursSha);
  const theirsCommit = getObject(theirsSha);
  if (!baseCommit || !oursCommit || !theirsCommit) return undefined;
  if (baseCommit.type !== 'commit' || oursCommit.type !== 'commit' || theirsCommit.type !== 'commit') return undefined;
  const base = flattenTree(parseCommit(baseCommit.data).tree);
  const ours = flattenTree(parseCommit(oursCommit.data).tree);
  const theirs = flattenTree(parseCommit(theirsCommit.data).tree);
  const merged = new Map<string, { mode: string; sha: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: TreeEntry, y?: TreeEntry) => x?.sha === y?.sha && x?.mode === y?.mode;
    let pick: TreeEntry | undefined;
    if (same(t, b)) pick = o;
    else if (same(o, b)) pick = t;
    else if (same(o, t)) pick = o;
    else return undefined; // Both sides changed the same path differently.
    if (pick) merged.set(path, { mode: pick.mode, sha: pick.sha });
  }
  return buildTree(merged);
}

export function mergePull(
  repo: Repo,
  pull: PullRequest,
  method: 'merge' | 'squash' | 'rebase',
  title: string | undefined,
  message: string | undefined,
): MergeOutcome | undefined {
  const baseTip = repo.refs.get(branchRef(pull.baseRef));
  if (!baseTip) return undefined;
  const basePoint = mergeBase(baseTip, pull.headSha) ?? pull.baseSha;
  const tree = mergeTrees(basePoint, baseTip, pull.headSha);
  if (!tree) return undefined;
  const stamp = isoNow();
  const ident = formatIdent(VIEWER.name, VIEWER.email, new Date(stamp));
  let commitSha: string;
  if (method === 'squash') {
    const text = `${title ?? pull.title} (#${pull.number})${message ? `\n\n${message}` : pull.body ? `\n\n${pull.body}` : ''}\n`;
    commitSha = storeObject('commit', serializeCommit({
      tree, parents: [baseTip], author: ident, committer: ident, message: text,
    }));
  } else {
    // 'merge' (and 'rebase', which this forge answers with a merge commit).
    const text = `${title ?? `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}`}${message ? `\n\n${message}` : ''}\n`;
    commitSha = storeObject('commit', serializeCommit({
      tree, parents: [baseTip, pull.headSha], author: ident, committer: ident, message: text,
    }));
  }
  repo.refs.set(branchRef(pull.baseRef), commitSha);
  repo.updatedAt = stamp;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = stamp;
  const issueView = repo.issues.get(pull.number);
  if (issueView) {
    issueView.state = 'closed';
    issueView.updatedAt = stamp;
  }
  return { sha: commitSha };
}

// ----------------------------------------------------------------- routing ---

interface Ctx {
  body: Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Routes under /api/v3/repos/{owner}/{name}/... for labels, issues and pulls. */
export function routeSocial(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  segments: string[],
  query: URLSearchParams,
  ctx: Ctx,
): boolean {
  const method = req.method ?? 'GET';
  const base = baseUrl(req);
  const apiBase = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const [head, second, third] = segments;

  // ------------------------------------------------------------- labels ---
  if (head === 'labels') {
    if (method === 'GET' && segments.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(req, repo, label)));
      return true;
    }
    if (method === 'POST' && segments.length === 1) {
      const name = bodyString(ctx.body, 'name');
      const color = (bodyString(ctx.body, 'color') ?? 'ededed').replace(/^#/, '');
      if (!name) {
        validationFailed(res, 'Label', 'name', 'name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        validationFailed(res, 'Label', 'name', 'Name has already been taken');
        return true;
      }
      const label: Label = {
        id: globalId(), name, color, description: bodyString(ctx.body, 'description') ?? null, isDefault: false,
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(req, repo, label));
      return true;
    }
    if (method === 'GET' && segments.length === 2) {
      const label = repo.labels.get(decodeURIComponent(second));
      if (!label) { notFound(res); return true; }
      sendJson(res, 200, labelJson(req, repo, label));
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- issues ---
  if (head === 'issues') {
    if (method === 'POST' && segments.length === 1) {
      const title = bodyString(ctx.body, 'title');
      if (!title) {
        validationFailed(res, 'Issue', 'title', 'title is required');
        return true;
      }
      const labelNames = Array.isArray(ctx.body.labels) ? (ctx.body.labels as unknown[]).map(String) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          sendJson(res, 422, {
            message: 'Validation Failed',
            errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `Label '${name}' does not exist` }],
          });
          return true;
        }
      }
      const stamp = isoNow();
      const issue: Issue = {
        id: globalId(),
        number: repo.nextNumber,
        title,
        body: bodyString(ctx.body, 'body') ?? null,
        state: 'open',
        labels: labelNames,
        userLogin: VIEWER.login,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
        isPullRequest: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      sendJson(res, 201, issueJson(req, repo, issue));
      return true;
    }
    if (method === 'GET' && segments.length === 1) {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      void sort;
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(query);
      const sliced = paginate(req, res, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, list, page);
      sendJson(res, 200, sliced.map((issue) => issueJson(req, repo, issue)));
      return true;
    }
    const number = Number.parseInt(second ?? '', 10);
    const issue = Number.isNaN(number) ? undefined : repo.issues.get(number);
    if (segments.length === 2 && issue) {
      if (method === 'GET') {
        sendJson(res, 200, issueJson(req, repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (bodyString(ctx.body, 'title') !== undefined) issue.title = bodyString(ctx.body, 'title') as string;
        if ('body' in ctx.body) issue.body = bodyString(ctx.body, 'body') ?? null;
        const state = bodyString(ctx.body, 'state');
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          const pull = repo.pulls.get(issue.number);
          if (pull && issue.isPullRequest) {
            pull.state = state;
            pull.updatedAt = isoNow();
          }
        }
        if (Array.isArray(ctx.body.labels)) {
          const names = (ctx.body.labels as unknown[]).map(String);
          for (const name of names) {
            if (!repo.labels.has(name)) {
              sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
              return true;
            }
          }
          issue.labels = names;
        }
        issue.updatedAt = isoNow();
        sendJson(res, 200, issueJson(req, repo, issue));
        return true;
      }
      return false;
    }
    if (segments.length === 3 && third === 'comments' && issue) {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: nodeId('IssueComment', comment.id),
          url: `${apiBase}/issues/comments/${comment.id}`,
          html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
          body: comment.body,
          user: userJson(req, userByLogin(comment.userLogin) ?? VIEWER),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
          issue_url: `${apiBase}/issues/${issue.number}`,
          author_association: 'OWNER',
        })));
        return true;
      }
      if (method === 'POST') {
        const text = bodyString(ctx.body, 'body');
        if (!text) {
          validationFailed(res, 'IssueComment', 'body', 'body is required');
          return true;
        }
        const stamp = isoNow();
        const comment = {
          id: globalId(), body: text, userLogin: VIEWER.login, createdAt: stamp, updatedAt: stamp,
        };
        issue.comments.push(comment);
        issue.updatedAt = stamp;
        sendJson(res, 201, {
          id: comment.id,
          node_id: nodeId('IssueComment', comment.id),
          url: `${apiBase}/issues/comments/${comment.id}`,
          html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
          body: comment.body,
          user: userJson(req, VIEWER),
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
          issue_url: `${apiBase}/issues/${issue.number}`,
          author_association: 'OWNER',
        });
        return true;
      }
      return false;
    }
    if (segments.length >= 2 && !issue) {
      notFound(res);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------- pulls ---
  if (head === 'pulls') {
    if (method === 'POST' && segments.length === 1) {
      const title = bodyString(ctx.body, 'title');
      const headRaw = (bodyString(ctx.body, 'head') ?? '').replace(new RegExp(`^${repo.owner}:`), '');
      const baseRaw = (bodyString(ctx.body, 'base') ?? '').replace(new RegExp(`^${repo.owner}:`), '');
      const headSha = repo.refs.get(branchRef(headRaw));
      const baseSha = repo.refs.get(branchRef(baseRaw));
      if (!title || !headSha || !baseSha || headRaw === baseRaw) {
        sendJson(res, 422, {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: 'Head and base must exist and differ' }],
        });
        return true;
      }
      if (isAncestor(headSha, baseSha)) {
        sendJson(res, 422, {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: `No commits between ${baseRaw} and ${headRaw}` }],
        });
        return true;
      }
      const existing = [...repo.pulls.values()].find(
        (p) => p.state === 'open' && p.headRef === headRaw && p.baseRef === baseRaw,
      );
      if (existing) {
        sendJson(res, 422, {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: `A pull request already exists for ${repo.owner}:${headRaw}.` }],
        });
        return true;
      }
      const stamp = isoNow();
      const pull: PullRequest = {
        id: globalId(),
        number: repo.nextNumber,
        title,
        body: bodyString(ctx.body, 'body') ?? null,
        state: 'open',
        draft: ctx.body.draft === true,
        headRef: headRaw,
        headSha,
        baseRef: baseRaw,
        baseSha,
        userLogin: VIEWER.login,
        createdAt: stamp,
        updatedAt: stamp,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.issues.set(pull.number, {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        labels: [],
        userLogin: VIEWER.login,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
        isPullRequest: true,
      });
      sendJson(res, 201, pullJson(req, repo, pull));
      return true;
    }
    if (method === 'GET' && segments.length === 1) {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const page = pageOf(query);
      const sliced = paginate(req, res, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, list, page);
      sendJson(res, 200, sliced.map((pull) => pullJson(req, repo, pull)));
      return true;
    }
    const number = Number.parseInt(second ?? '', 10);
    const pull = Number.isNaN(number) ? undefined : repo.pulls.get(number);
    if (!pull) {
      notFound(res);
      return true;
    }
    if (segments.length === 2) {
      if (method === 'GET') {
        // Refresh the head/base shas from the live refs, as GitHub does.
        pull.headSha = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
        sendJson(res, 200, pullJson(req, repo, pull));
        return true;
      }
      if (method === 'PATCH') {
        if (bodyString(ctx.body, 'title') !== undefined) pull.title = bodyString(ctx.body, 'title') as string;
        if ('body' in ctx.body) pull.body = bodyString(ctx.body, 'body') ?? null;
        const state = bodyString(ctx.body, 'state');
        if (state === 'open' || state === 'closed') pull.state = state;
        pull.updatedAt = isoNow();
        const issueView = repo.issues.get(pull.number);
        if (issueView) {
          issueView.title = pull.title;
          issueView.body = pull.body;
          issueView.state = pull.state;
          issueView.updatedAt = pull.updatedAt;
        }
        sendJson(res, 200, pullJson(req, repo, pull));
        return true;
      }
      return false;
    }
    if (segments.length === 3 && third === 'files' && method === 'GET') {
      const files = prFiles(repo, pull);
      const page = pageOf(query);
      const sliced = paginate(req, res, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/files`, query, files, page);
      sendJson(res, 200, sliced.map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: `${apiBase}/contents/${file.filename}`,
        raw_url: `${base}/${repo.owner}/${repo.name}/raw/${pull.headRef}/${file.filename}`,
        contents_url: `${apiBase}/contents/${file.filename}?ref=${pull.headRef}`,
        patch: file.patch,
      })));
      return true;
    }
    if (segments.length === 3 && third === 'merge') {
      if (method === 'GET') {
        if (pull.merged) {
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
        } else {
          notFound(res);
        }
        return true;
      }
      if (method === 'PUT') {
        if (pull.merged) {
          sendJson(res, 405, { message: 'Pull Request has already been merged' });
          return true;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull Request is not open' });
          return true;
        }
        const expected = bodyString(ctx.body, 'sha');
        const liveHead = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
        if (expected && expected !== liveHead) {
          sendJson(res, 409, { message: 'Head branch was modified. Review and try the merge again.' });
          return true;
        }
        pull.headSha = liveHead;
        const methodName = (bodyString(ctx.body, 'merge_method') ?? 'merge') as 'merge' | 'squash' | 'rebase';
        const outcome = mergePull(
          repo,
          pull,
          methodName === 'squash' ? 'squash' : 'merge',
          bodyString(ctx.body, 'commit_title'),
          bodyString(ctx.body, 'commit_message'),
        );
        if (!outcome) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable' });
          return true;
        }
        sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }

  return false;
}
