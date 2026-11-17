// Shared REST v3 presentation helpers: GitHub-shaped JSON for users and
// repositories, URL building from the request's own host, and pagination
// with Link headers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Repo, type ScenarioUser } from './forge.ts';
import { sendJson } from './webutil.ts';

export function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

const nodeIdCache = new Map<string, string>();

export function nodeId(kind: string, id: number): string {
  // GitHub's legacy node id scheme: base64 of "<prefix>:<Kind><id>". The
  // mapping is a pure function of (kind, id), so memoise it: hot JSON
  // builders ask for the same ids on every request.
  const key = `${kind}:${id}`;
  let cached = nodeIdCache.get(key);
  if (cached === undefined) {
    const prefixes: Record<string, string> = {
      User: '04', Repository: '07', Issue: '05', PullRequest: '09', Label: '06', IssueComment: '03',
    };
    const prefix = prefixes[kind] ?? '00';
    cached = Buffer.from(`${prefix}:${kind}${id}`, 'utf8').toString('base64');
    if (nodeIdCache.size >= 4096) nodeIdCache.clear();
    nodeIdCache.set(key, cached);
  }
  return cached;
}

export function userJson(req: IncomingMessage, user: ScenarioUser | typeof VIEWER): Record<string, unknown> {
  const base = baseUrl(req);
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    avatar_url: `${base}/avatars/${user.login}`,
    gravatar_id: '',
    url: `${base}/api/v3/users/${user.login}`,
    html_url: `${base}/${user.login}`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const base = baseUrl(req);
  const owner = { login: repo.owner, id: VIEWER.id, node_id: nodeId('User', VIEWER.id), type: 'User', url: `${base}/api/v3/users/${repo.owner}`, html_url: `${base}/${repo.owner}` };
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.isPrivate,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${req.headers.host ?? 'localhost'}:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

export interface Page {
  perPage: number;
  page: number;
}

export function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice `items` for the page and set the Link header when more pages exist. */
export function paginate<T>(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, items: T[], page: Page): T[] {
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  const links: string[] = [];
  const url = (p: number) => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(page.perPage));
    return `<${baseUrl(req)}${path}?${q.toString()}>`;
  };
  if (page.page < lastPage) {
    links.push(`${url(page.page + 1)}; rel="next"`, `${url(lastPage)}; rel="last"`);
  }
  if (page.page > 1) {
    links.push(`${url(page.page - 1)}; rel="prev"`, `${url(1)}; rel="first"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

export function validationFailed(res: ServerResponse, resource: string, field: string, message = 'Validation Failed'): void {
  sendJson(res, 422, {
    message,
    errors: [{ resource, field, code: 'custom', message }],
  });
}
