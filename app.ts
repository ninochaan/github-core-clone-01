// The forge's HTTP surface: routing, the protocol rules every reply obeys,
// and REST v3 for users, repositories, branches, commits and contents. The
// git wire protocol lives in gitproto.ts, the social layer in social.ts,
// GraphQL in graphql.ts and MCP in mcp.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER, branchRef, createRepo, deleteRepo, getRepo, isoNow, now, reposOf,
  resolveRef, userByEmail, type Repo,
} from './forge.ts';
import {
  buildTree, commitHistory, flattenTree, formatIdent, getObject, parseCommit, parseIdent,
  parseTree, serializeCommit, storeObject,
} from './gitstore.ts';
import { handleGitRoute, tokenOk } from './gitproto.ts';
import { routeSocial } from './social.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { diffText } from './diff.ts';
import { baseUrl, pageOf, paginate, repoJson, userJson, validationFailed } from './restutil.ts';
import { badCredentials, notFound, readBody, sendJson } from './webutil.ts';

// ---------------------------------------------------------------- helpers ---

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function commitJson(req: IncomingMessage, repo: Repo, sha: string, withFiles: boolean): Record<string, unknown> | undefined {
  const obj = getObject(sha);
  if (!obj || obj.type !== 'commit') return undefined;
  const commit = parseCommit(obj.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const authorUser = userByEmail(author.email);
  const committerUser = userByEmail(committer.email);
  const base = baseUrl(req);
  const apiBase = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const json: Record<string, unknown> = {
    sha,
    node_id: Buffer.from(`06:Commit${sha}`, 'utf8').toString('base64'),
    url: `${apiBase}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${apiBase}/commits/${sha}/comments`,
    commit: {
      author: { name: author.name, email: author.email, date: author.date.toISOString() },
      committer: { name: committer.name, email: committer.email, date: committer.date.toISOString() },
      message: commit.message.replace(/[\r\n]+$/, ''),
      tree: { sha: commit.tree, url: `${apiBase}/git/trees/${commit.tree}` },
      url: `${apiBase}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: authorUser ? userJson(req, authorUser) : null,
    committer: committerUser ? userJson(req, committerUser) : null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${apiBase}/commits/${parent}`, html_url: `${base}/${repo.owner}/${repo.name}/commit/${parent}` })),
  };
  if (withFiles) {
    const parentObj = commit.parents.length > 0 ? getObject(commit.parents[0]) : undefined;
    const parentTree = parentObj && parentObj.type === 'commit' ? parseCommit(parentObj.data).tree : undefined;
    const before = parentTree ? flattenTree(parentTree) : new Map();
    const after = flattenTree(commit.tree);
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const files = [];
    for (const path of paths) {
      const b = before.get(path);
      const a = after.get(path);
      if (b && a && b.sha === a.sha) continue;
      const diff = diffText(
        b ? (getObject(b.sha)?.data.toString('utf8') ?? '') : '',
        a ? (getObject(a.sha)?.data.toString('utf8') ?? '') : '',
      );
      files.push({
        sha: a?.sha ?? b?.sha ?? '',
        filename: path,
        status: !b ? 'added' : !a ? 'removed' : 'modified',
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
        blob_url: `${apiBase}/contents/${path}`,
        raw_url: `${base}/${repo.owner}/${repo.name}/raw/${sha}/${path}`,
        contents_url: `${apiBase}/contents/${path}?ref=${sha}`,
        patch: diff.patch === '' ? undefined : diff.patch,
      });
    }
    json.files = files;
    json.stats = {
      total: files.reduce((sum, f) => sum + f.changes, 0),
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    };
  }
  return json;
}

/** Create a commit on `branch` replacing the tree with `files`, from the API (contents writes). */
function apiCommit(repo: Repo, branch: string, files: Map<string, { mode: string; sha: string }>, message: string): string {
  const ref = branchRef(branch);
  const parent = repo.refs.get(ref);
  const tree = buildTree(files);
  const ident = formatIdent(VIEWER.name, VIEWER.email, now());
  const sha = storeObject('commit', serializeCommit({
    tree,
    parents: parent ? [parent] : [],
    author: ident,
    committer: ident,
    message: message.endsWith('\n') ? message : `${message}\n`,
  }));
  repo.refs.set(ref, sha);
  repo.updatedAt = isoNow();
  return sha;
}

// -------------------------------------------------------------- REST core ---

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawPath = pathOf(req);
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const query = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));

  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
  }

  const rest = segments.slice(2);

  // The API root (public, as on GitHub).
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
    } else {
      notFound(res);
    }
    return;
  }

  if (!tokenOk(req)) {
    badCredentials(res);
    return;
  }

  // ---------------------------------------------------------------- meta ---
  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      installed_version: '3.16.0',
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
    return;
  }

  // ---------------------------------------------------------------- user ---
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      ...userJson(req, VIEWER),
      company: null, blog: '', location: null, hireable: null, bio: null,
      public_repos: reposOf(VIEWER.login).length, followers: 0, following: 0,
      created_at: '2020-01-01T00:00:00Z', updated_at: isoNow(),
    });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', field: 'name', code: 'missing_field', message: 'name is required' }],
        });
        return;
      }
      if (getRepo(VIEWER.login, name)) {
        sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }],
        });
        return;
      }
      const repo = createRepo(VIEWER.login, name, {
        description: typeof body.description === 'string' ? body.description : null,
        isPrivate: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      sendJson(res, 201, repoJson(req, repo));
      return;
    }
    if (method === 'GET') {
      const page = pageOf(query);
      const mine = reposOf(VIEWER.login).sort((a, b) => a.id - b.id);
      const sliced = paginate(req, res, '/api/v3/user/repos', query, mine, page);
      sendJson(res, 200, sliced.map((repo) => repoJson(req, repo)));
      return;
    }
    notFound(res);
    return;
  }

  // --------------------------------------------------------------- repos ---
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = getRepo(owner, name);
    if (!repo) {
      notFound(res);
      return;
    }
    const sub = rest.slice(3);
    const base = baseUrl(req);
    const apiBase = `${base}/api/v3/repos/${owner}/${name}`;

    if (sub.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(req, repo)); return; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string' || body.description === null) repo.description = body.description as string | null;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        repo.updatedAt = isoNow();
        sendJson(res, 200, repoJson(req, repo));
        return;
      }
      if (method === 'DELETE') {
        deleteRepo(owner, name);
        res.writeHead(204);
        res.end();
        return;
      }
      notFound(res);
      return;
    }

    // ------------------------------------------------------------ branches
    if (sub[0] === 'branches') {
      if (sub.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha, url: `${apiBase}/commits/${sha}` },
            protected: false,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      if (sub.length >= 2 && method === 'GET') {
        const branch = sub.slice(1).join('/');
        const sha = repo.refs.get(branchRef(branch));
        if (!sha) { notFound(res); return; }
        sendJson(res, 200, {
          name: branch,
          commit: commitJson(req, repo, sha, false) ?? { sha },
          protected: false,
          _links: { self: `${apiBase}/branches/${branch}`, html: `${base}/${owner}/${name}/tree/${branch}` },
        });
        return;
      }
      notFound(res);
      return;
    }

    // ------------------------------------------------------------- commits
    if (sub[0] === 'commits') {
      if (sub.length === 1 && method === 'GET') {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip || getObject(tip)?.type !== 'commit') { sendJson(res, 200, []); return; }
        const history = commitHistory(tip, 10000);
        const page = pageOf(query);
        const sliced = paginate(req, res, `/api/v3/repos/${owner}/${name}/commits`, query, history, page);
        sendJson(res, 200, sliced.map((sha) => commitJson(req, repo, sha, false)).filter(Boolean));
        return;
      }
      if (sub.length === 2 && method === 'GET') {
        const json = commitJson(req, repo, sub[1], true);
        if (!json) { notFound(res); return; }
        sendJson(res, 200, json);
        return;
      }
      notFound(res);
      return;
    }

    // ------------------------------------------------------------ contents
    if (sub[0] === 'contents') {
      const contentPath = sub.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, ref);
        if (!tip) { notFound(res); return; }
        const commitObj = getObject(tip);
        if (!commitObj || commitObj.type !== 'commit') { notFound(res); return; }
        const rootTree = parseCommit(commitObj.data).tree;
        const files = flattenTree(rootTree);
        if (contentPath === '') {
          const rootObj = getObject(rootTree);
          const top = rootObj && rootObj.type === 'tree' ? parseTree(rootObj.data) : [];
          sendJson(res, 200, top.map((entry) => ({
            name: entry.name,
            path: entry.name,
            sha: entry.sha,
            size: entry.mode === '40000' ? 0 : (getObject(entry.sha)?.data.length ?? 0),
            type: entry.mode === '40000' ? 'dir' : 'file',
            url: `${apiBase}/contents/${entry.name}?ref=${ref}`,
            html_url: `${base}/${owner}/${name}/blob/${ref}/${entry.name}`,
            git_url: `${apiBase}/git/blobs/${entry.sha}`,
            download_url: entry.mode === '40000' ? null : `${base}/${owner}/${name}/raw/${ref}/${entry.name}`,
          })));
          return;
        }
        const file = files.get(contentPath);
        if (file) {
          const data = getObject(file.sha)?.data ?? Buffer.alloc(0);
          const encoded = data.toString('base64').replace(/(.{60})/g, '$1\n');
          sendJson(res, 200, {
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: file.sha,
            size: data.length,
            url: `${apiBase}/contents/${contentPath}?ref=${ref}`,
            html_url: `${base}/${owner}/${name}/blob/${ref}/${contentPath}`,
            git_url: `${apiBase}/git/blobs/${file.sha}`,
            download_url: `${base}/${owner}/${name}/raw/${ref}/${contentPath}`,
            type: 'file',
            content: `${encoded}\n`,
            encoding: 'base64',
          });
          return;
        }
        const prefix = `${contentPath}/`;
        const children = new Map<string, { sha: string; isDir: boolean; size: number }>();
        for (const [path, entry] of files) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const head = restPath.split('/')[0];
          if (restPath.includes('/')) {
            if (!children.has(head)) children.set(head, { sha: '', isDir: true, size: 0 });
          } else {
            children.set(head, { sha: entry.sha, isDir: false, size: getObject(entry.sha)?.data.length ?? 0 });
          }
        }
        if (children.size > 0) {
          sendJson(res, 200, [...children.entries()].map(([childName, child]) => ({
            name: childName,
            path: `${contentPath}/${childName}`,
            sha: child.sha,
            size: child.size,
            type: child.isDir ? 'dir' : 'file',
            url: `${apiBase}/contents/${contentPath}/${childName}?ref=${ref}`,
            html_url: `${base}/${owner}/${name}/blob/${ref}/${contentPath}/${childName}`,
            download_url: child.isDir ? null : `${base}/${owner}/${name}/raw/${ref}/${contentPath}/${childName}`,
          })));
          return;
        }
        notFound(res);
        return;
      }
      if (method === 'PUT') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const ref = branchRef(branch);
        const tip = repo.refs.get(ref);
        if (!tip && branch !== repo.defaultBranch) { notFound(res); return; }
        const message = typeof body.message === 'string' ? body.message : '';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        if (message === '' || contentPath === '') {
          validationFailed(res, 'Contents', 'message', 'message and path are required');
          return;
        }
        const data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        const blobSha = storeObject('blob', data);
        const tipObj = tip ? getObject(tip) : undefined;
        const files = tipObj && tipObj.type === 'commit' ? flattenTree(parseCommit(tipObj.data).tree) : new Map();
        const existing = files.get(contentPath);
        if (existing && typeof body.sha !== 'string') {
          sendJson(res, 422, { message: "sha wasn't supplied" });
          return;
        }
        if (existing && body.sha !== existing.sha) {
          sendJson(res, 409, { message: `${contentPath} does not match ${body.sha}` });
          return;
        }
        const flat = new Map<string, { mode: string; sha: string }>();
        for (const [path, entry] of files) flat.set(path, { mode: entry.mode, sha: entry.sha });
        flat.set(contentPath, { mode: existing?.mode ?? '100644', sha: blobSha });
        const commitSha = apiCommit(repo, branch, flat, message);
        sendJson(res, existing ? 200 : 201, {
          content: {
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: blobSha,
            size: data.length,
            type: 'file',
            encoding: 'base64',
            url: `${apiBase}/contents/${contentPath}?ref=${branch}`,
            html_url: `${base}/${owner}/${name}/blob/${branch}/${contentPath}`,
            git_url: `${apiBase}/git/blobs/${blobSha}`,
            download_url: `${base}/${owner}/${name}/raw/${branch}/${contentPath}`,
          },
          commit: {
            sha: commitSha,
            url: `${apiBase}/commits/${commitSha}`,
            html_url: `${base}/${owner}/${name}/commit/${commitSha}`,
            message,
            author: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
          },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = repo.refs.get(branchRef(branch));
        if (!tip) { notFound(res); return; }
        const tipObj = getObject(tip);
        if (!tipObj || tipObj.type !== 'commit') { notFound(res); return; }
        const files = flattenTree(parseCommit(tipObj.data).tree);
        const existing = files.get(contentPath);
        if (!existing) { notFound(res); return; }
        if (typeof body.sha !== 'string' || body.sha !== existing.sha) {
          sendJson(res, 409, { message: `${contentPath} does not match the supplied sha` });
          return;
        }
        const message = typeof body.message === 'string' ? body.message : `Delete ${contentPath}`;
        const flat = new Map<string, { mode: string; sha: string }>();
        for (const [path, entry] of files) {
          if (path !== contentPath) flat.set(path, { mode: entry.mode, sha: entry.sha });
        }
        const commitSha = apiCommit(repo, branch, flat, message);
        sendJson(res, 200, {
          content: null,
          commit: { sha: commitSha, url: `${apiBase}/commits/${commitSha}`, message },
        });
        return;
      }
      notFound(res);
      return;
    }

    // ------------------------------------------------------------ git refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'POST' && sub.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const obj = getObject(sha);
        if (!obj) {
          sendJson(res, 422, { message: 'Object does not exist' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        repo.updatedAt = isoNow();
        sendJson(res, 201, {
          ref,
          node_id: Buffer.from(`08:Reference${repo.id}${ref}`, 'utf8').toString('base64'),
          url: `${apiBase}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: obj.type, url: `${apiBase}/git/commits/${sha}` },
        });
        return;
      }
      if (method === 'GET') {
        if (sub.length === 2) {
          sendJson(res, 200, [...repo.refs.entries()].map(([refName, sha]) => ({
            ref: refName,
            node_id: Buffer.from(`08:Reference${repo.id}${refName}`, 'utf8').toString('base64'),
            url: `${apiBase}/git/refs/${refName.replace(/^refs\//, '')}`,
            object: { sha, type: getObject(sha)?.type ?? 'commit' },
          })));
          return;
        }
        const ref = `refs/${sub.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) { notFound(res); return; }
        sendJson(res, 200, {
          ref,
          node_id: Buffer.from(`08:Reference${repo.id}${ref}`, 'utf8').toString('base64'),
          url: `${apiBase}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: getObject(sha)?.type ?? 'commit', url: `${apiBase}/git/commits/${sha}` },
        });
        return;
      }
      notFound(res);
      return;
    }

    // ------------------------------------------- labels, issues, pulls ---
    if (routeSocial(req, res, repo, sub, query, { body })) return;

    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------- server ---

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const handled = await handleGitRoute(
            req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]),
            gitMatch[3] ?? '', queryOf(req),
          );
          if (handled) return;
          notFound(res);
          return;
        }

        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }

        if (path === '/api/graphql') {
          await handleGraphql(req, res);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res);
          return;
        }

        notFound(res);
      } catch (err) {
        console.error('forge error:', err);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
