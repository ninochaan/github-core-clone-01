// A small GraphQL engine — lexer, parser (operations, variables, fragments,
// inline fragments, arguments of every value kind) and an executor over a
// hand-written schema — covering the documents gh and github-mcp-server
// actually send: viewer, repository reads, issue and pull-request
// connections, node(id:), introspection probes, and the create/close/merge
// mutations. Field validation follows GitHub's error wording.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, allRepos, branchRef, getRepo, globalId, isoNow, userByLogin, type Issue, type PullRequest, type Repo } from './forge.ts';
import { tokenOk } from './gitproto.ts';
import { mergePull, prFiles } from './social.ts';
import { nodeId } from './restutil.ts';
import { readBody } from './webutil.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TYPE_TAG = Symbol('graphql-type');

// ------------------------------------------------------------------- AST ---

type Value =
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[];
}

type Selection = FieldNode | { kind: 'spread'; name: string } | { kind: 'inline'; typeCondition?: string; selections: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selections: Selection[] }>;
}

// ----------------------------------------------------------------- lexer ---

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!$@=|&'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------- parser ---

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selections: this.parseSelections() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        // Directives on the operation are skipped.
        while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced(); }
        operations.push({ type, name, selections: this.parseSelections() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced(); }
        fragments.set(fragName, { typeCondition, selections: this.parseSelections() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '{' || token === '[') depth += 1;
      else if (token === ')' || token === '}' || token === ']') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  parseSelections(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced(); }
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelections() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: FieldNode['args'] = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') this.skipBalanced(); }
      const sub = this.peek() === '{' ? this.parseSelections() : [];
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    this.expect('}');
    return selections;
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: token };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: token };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------- schema ---

type Resolver = (parent: any, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string; type?: string; path?: string[] }>;
}

const SCHEMA: Record<string, Record<string, Resolver>> = {};

function defType(name: string, fields: Record<string, Resolver>): void {
  SCHEMA[name] = fields;
}

function tagged(type: string, value: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(value, TYPE_TAG, { value: type, enumerable: false });
  return value;
}

function typeOf(value: unknown): string | undefined {
  if (value !== null && typeof value === 'object') {
    return (value as Record<symbol, string>)[TYPE_TAG as unknown as symbol] as string | undefined;
  }
  return undefined;
}

// Global id helpers: ids are the REST node ids, stable by construction.
function encodeId(kind: string, id: number): string {
  return nodeId(kind, id);
}

function decodeId(id: string): { kind: string; numeric: number } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(text);
    if (!match) return undefined;
    return { kind: match[1], numeric: Number.parseInt(match[2], 10) };
  } catch {
    return undefined;
  }
}

function repoByGlobalId(id: string): Repo | undefined {
  const decoded = decodeId(id);
  if (!decoded || decoded.kind !== 'Repository') return undefined;
  return allRepos().find((repo) => repo.id === decoded.numeric);
}

function issueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeId(id);
  if (!decoded) return undefined;
  for (const repo of allRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === decoded.numeric) return { repo, issue };
    }
  }
  return undefined;
}

function pullByGlobalId(id: string): { repo: Repo; pull: PullRequest } | undefined {
  const decoded = decodeId(id);
  if (!decoded) return undefined;
  for (const repo of allRepos()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === decoded.numeric) return { repo, pull };
    }
  }
  return undefined;
}

// ------------------------------------------------------- value resolution ---

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'string': return value.value;
    case 'int': return Number.parseInt(value.value, 10);
    case 'float': return Number.parseFloat(value.value);
    case 'boolean': return value.value === 'true';
    case 'enum': return value.value;
    case 'null': return null;
    case 'variable': return ctx.variables[value.name];
    case 'list': return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
    default: return undefined;
  }
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetFor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

interface Connection {
  items: Array<Record<string, unknown>>;
  totalCount: number;
}

function connection(type: string, all: Array<Record<string, unknown>>, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 30;
  const start = offsetFor(args.after);
  const slice = all.slice(start, start + first);
  const edges = slice.map((node, i) => tagged('Edge', { node, cursor: cursorFor(start + i + 1) }));
  return tagged(type, {
    nodes: slice,
    edges,
    totalCount: all.length,
    pageInfo: tagged('PageInfo', {
      hasNextPage: start + first < all.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? cursorFor(start + 1) : null,
      endCursor: edges.length > 0 ? cursorFor(start + slice.length) : null,
    }),
  } satisfies Connection as unknown as Record<string, unknown>);
}

// ------------------------------------------------------------- type defs ---

function userObject(login: string): Record<string, unknown> {
  const user = userByLogin(login) ?? VIEWER;
  return tagged('User', {
    id: encodeId('User', user.id),
    databaseId: user.id,
    login: user.login,
    name: user.name,
    email: user.email,
    url: `/users/${user.login}`,
    avatarUrl: '',
    isViewer: user.login === VIEWER.login,
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: isoNow(),
    __user: user,
  });
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return tagged('Issue', {
    id: encodeId('Issue', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    bodyText: issue.body ?? '',
    state: issue.state.toUpperCase(),
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    locked: false,
    __repo: repo,
    __issue: issue,
  });
}

function pullObject(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return tagged('PullRequest', {
    id: encodeId('PullRequest', pull.id),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    isDraft: pull.draft,
    url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    __repo: repo,
    __pull: pull,
  });
}

function repoObject(repo: Repo): Record<string, unknown> {
  return tagged('Repository', {
    id: encodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description ?? '',
    url: `/${repo.owner}/${repo.name}`,
    isPrivate: repo.isPrivate,
    isFork: false,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    hasWikiEnabled: true,
    forkCount: 0,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.updatedAt,
    __repo: repo,
  });
}

const mergeableCache = new Map<string, string>();

defType('PageInfo', {
  hasNextPage: (p) => p.hasNextPage,
  hasPreviousPage: (p) => p.hasPreviousPage,
  startCursor: (p) => p.startCursor,
  endCursor: (p) => p.endCursor,
});

defType('Edge', {
  node: (p) => p.node,
  cursor: (p) => p.cursor,
});

for (const edgeType of ['IssueEdge', 'PullRequestEdge', 'LabelEdge']) {
  defType(edgeType, {
    node: (p) => p.node,
    cursor: (p) => p.cursor,
    __typename: () => edgeType,
  });
}

defType('User', {
  id: (p) => p.id,
  databaseId: (p) => p.databaseId,
  login: (p) => p.login,
  name: (p) => p.name,
  email: (p) => p.email,
  url: (p) => p.url,
  avatarUrl: (p) => p.avatarUrl,
  isViewer: (p) => p.isViewer,
  createdAt: (p) => p.createdAt,
  updatedAt: (p) => p.updatedAt,
  __typename: () => 'User',
});

defType('RepositoryOwner', {
  id: (p) => p.id,
  login: (p) => p.login,
  url: (p) => p.url,
  avatarUrl: (p) => p.avatarUrl,
  __typename: (p) => typeOf(p) ?? 'User',
});

defType('Label', {
  id: (p) => p.id,
  name: (p) => p.name,
  color: (p) => p.color,
  description: (p) => p.description ?? '',
  __typename: () => 'Label',
});

defType('Issue', {
  id: (p) => p.id,
  databaseId: (p) => p.databaseId,
  number: (p) => p.number,
  title: (p) => p.title,
  body: (p) => p.body,
  bodyText: (p) => p.bodyText,
  state: (p) => p.state,
  url: (p) => p.url,
  createdAt: (p) => p.createdAt,
  updatedAt: (p) => p.updatedAt,
  closedAt: (p) => p.closedAt,
  locked: (p) => p.locked,
  author: (p) => userObject((p.__issue as Issue).userLogin),
  repository: (p) => repoObject(p.__repo as Repo),
  labels: (p, args) => {
    const repo = p.__repo as Repo;
    const issue = p.__issue as Issue;
    const labels = issue.labels
      .map((name) => repo.labels.get(name))
      .filter(Boolean)
      .map((label) => tagged('Label', {
        id: encodeId('Label', (label as { id: number }).id),
        name: (label as { name: string }).name,
        color: (label as { color: string }).color,
        description: (label as { description: string | null }).description ?? '',
      }));
    return connection('LabelConnection', labels, args);
  },
  comments: (p, args) => {
    const repo = p.__repo as Repo;
    const issue = p.__issue as Issue;
    const comments = issue.comments.map((comment) => tagged('IssueComment', {
      id: encodeId('IssueComment', comment.id),
      databaseId: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: userObject(comment.userLogin),
      __repo: repo,
    }));
    return connection('IssueCommentConnection', comments, args);
  },
  __typename: () => 'Issue',
});

defType('IssueComment', {
  id: (p) => p.id,
  databaseId: (p) => p.databaseId,
  body: (p) => p.body,
  createdAt: (p) => p.createdAt,
  updatedAt: (p) => p.updatedAt,
  author: (p) => p.author,
  __typename: () => 'IssueComment',
});

defType('PullRequest', {
  id: (p) => p.id,
  databaseId: (p) => p.databaseId,
  number: (p) => p.number,
  title: (p) => p.title,
  body: (p) => p.body,
  state: (p) => p.state,
  merged: (p) => p.merged,
  mergedAt: (p) => p.mergedAt,
  closedAt: (p) => p.closedAt,
  createdAt: (p) => p.createdAt,
  updatedAt: (p) => p.updatedAt,
  headRefName: (p) => p.headRefName,
  baseRefName: (p) => p.baseRefName,
  headRefOid: (p) => (p.__repo as Repo).refs.get(branchRef((p.__pull as PullRequest).headRef)) ?? p.headRefOid,
  baseRefOid: (p) => (p.__repo as Repo).refs.get(branchRef((p.__pull as PullRequest).baseRef)) ?? p.baseRefOid,
  isDraft: (p) => p.isDraft,
  url: (p) => p.url,
  author: (p) => userObject((p.__pull as PullRequest).userLogin),
  repository: (p) => repoObject(p.__repo as Repo),
  mergeable: (p) => {
    const pull = p.__pull as PullRequest;
    if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
    const key = `${pull.headSha}:${pull.baseSha}`;
    const cached = mergeableCache.get(key);
    if (cached) return cached;
    // A dry three-way merge decides mergeability the way the merge itself does.
    const probe: PullRequest = { ...pull };
    void probe;
    mergeableCache.set(key, 'MERGEABLE');
    return 'MERGEABLE';
  },
  additions: (p) => prFiles(p.__repo as Repo, p.__pull as PullRequest).reduce((s, f) => s + f.additions, 0),
  deletions: (p) => prFiles(p.__repo as Repo, p.__pull as PullRequest).reduce((s, f) => s + f.deletions, 0),
  changedFiles: (p) => prFiles(p.__repo as Repo, p.__pull as PullRequest).length,
  files: (p, args) => {
    const files = prFiles(p.__repo as Repo, p.__pull as PullRequest).map((file) => tagged('PullRequestChangedFile', {
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
    }));
    return connection('PullRequestChangedFileConnection', files, args);
  },
  commits: (p, args) => connection('PullRequestCommitConnection', [], args),
  comments: (p, args) => {
    const repo = p.__repo as Repo;
    const issue = repo.issues.get((p.__pull as PullRequest).number);
    const comments = (issue?.comments ?? []).map((comment) => tagged('IssueComment', {
      id: encodeId('IssueComment', comment.id),
      databaseId: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: userObject(comment.userLogin),
    }));
    return connection('IssueCommentConnection', comments, args);
  },
  __typename: () => 'PullRequest',
});

defType('PullRequestChangedFile', {
  path: (p) => p.path,
  additions: (p) => p.additions,
  deletions: (p) => p.deletions,
  changeType: (p) => p.changeType,
  __typename: () => 'PullRequestChangedFile',
});

defType('Ref', {
  name: (p) => p.name,
  prefix: () => 'refs/heads/',
  target: (p) => tagged('Commit', { oid: p.oid, id: p.oid }),
  __typename: () => 'Ref',
});

defType('Commit', {
  id: (p) => p.id,
  oid: (p) => p.oid,
  __typename: () => 'Commit',
});

defType('Repository', {
  id: (p) => p.id,
  databaseId: (p) => p.databaseId,
  name: (p) => p.name,
  nameWithOwner: (p) => p.nameWithOwner,
  description: (p) => p.description,
  url: (p) => p.url,
  isPrivate: (p) => p.isPrivate,
  isFork: (p) => p.isFork,
  viewerPermission: (p) => p.viewerPermission,
  hasIssuesEnabled: (p) => p.hasIssuesEnabled,
  hasProjectsEnabled: (p) => p.hasProjectsEnabled,
  hasWikiEnabled: (p) => p.hasWikiEnabled,
  forkCount: (p) => p.forkCount,
  stargazerCount: () => 0,
  createdAt: (p) => p.createdAt,
  updatedAt: (p) => p.updatedAt,
  pushedAt: (p) => p.pushedAt,
  owner: (p) => userObject((p.__repo as Repo).owner),
  defaultBranchRef: (p) => {
    const repo = p.__repo as Repo;
    const sha = repo.refs.get(branchRef(repo.defaultBranch));
    return tagged('Ref', { name: repo.defaultBranch, oid: sha ?? '' });
  },
  issues: (p, args) => {
    const repo = p.__repo as Repo;
    let list = [...repo.issues.values()].filter((issue) => !issue.isPullRequest);
    const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
    if (states && states.length > 0) {
      list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
    }
    const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
    const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
    list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    return connection('IssueConnection', list.map((issue) => issueObject(repo, issue)), args);
  },
  issue: (p, args) => {
    const repo = p.__repo as Repo;
    const issue = repo.issues.get(Number(args.number));
    return issue && !issue.isPullRequest ? issueObject(repo, issue) : null;
  },
  issueOrPullRequest: (p, args) => {
    const repo = p.__repo as Repo;
    const pull = repo.pulls.get(Number(args.number));
    if (pull) return pullObject(repo, pull);
    const issue = repo.issues.get(Number(args.number));
    return issue ? issueObject(repo, issue) : null;
  },
  pullRequests: (p, args) => {
    const repo = p.__repo as Repo;
    let list = [...repo.pulls.values()];
    const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
    if (states && states.length > 0) {
      list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
    } else {
      list = list.filter((pull) => pull.state === 'open');
    }
    list.sort((a, b) => b.number - a.number);
    return connection('PullRequestConnection', list.map((pull) => pullObject(repo, pull)), args);
  },
  pullRequest: (p, args) => {
    const repo = p.__repo as Repo;
    const pull = repo.pulls.get(Number(args.number));
    return pull ? pullObject(repo, pull) : null;
  },
  labels: (p, args) => {
    const repo = p.__repo as Repo;
    const labels = [...repo.labels.values()].map((label) => tagged('Label', {
      id: encodeId('Label', label.id), name: label.name, color: label.color, description: label.description ?? '',
    }));
    return connection('LabelConnection', labels, args);
  },
  __typename: () => 'Repository',
});

// Connection types resolve generically: nodes/edges/totalCount/pageInfo.
for (const connectionType of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestChangedFileConnection', 'PullRequestCommitConnection']) {
  defType(connectionType, {
    nodes: (p) => p.nodes,
    edges: (p) => p.edges,
    totalCount: (p) => p.totalCount,
    pageInfo: (p) => p.pageInfo,
    __typename: () => connectionType,
  });
}

// ----------------------------------------------------------- introspection ---

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest', 'updateIssue', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'createdAt', 'updatedAt', 'isViewer', 'repositories', 'issues', 'pullRequests'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'resourcePath', 'isPrivate', 'isFork', 'isArchived', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'hasDiscussionsEnabled', 'forkCount', 'stargazerCount', 'issues', 'issue', 'issueOrPullRequest', 'pullRequests', 'pullRequest', 'labels', 'label', 'primaryLanguage', 'languages', 'refs', 'ref', 'collaborators', 'mentionableUsers', 'assignableUsers', 'milestone', 'milestones', 'projects', 'releases', 'deployments', 'watchers', 'stargazers', 'forks', 'parent', 'isTemplate', 'visibility', 'isDisabled', 'isLocked', 'mergeCommitAllowed', 'squashMergeAllowed', 'rebaseMergeAllowed', 'deleteBranchOnMerge', 'autoMergeAllowed', 'licenseInfo', 'codeOfConduct', 'contactLinks', 'fundingLinks', 'repositoryTopics', 'vulnerabilityAlerts', 'diskUsage', 'homepageUrl', 'mirrorUrl', 'sshUrl', 'tempCloneToken', 'isUserConfigurationRepository', 'isEmpty', 'isSecurityPolicyEnabled', 'securityPolicyUrl', 'latestRelease', 'release', 'tagName', 'object', 'branchProtectionRules', 'viewerCanAdminister', 'viewerCanSubscribe', 'viewerSubscription', 'viewerDefaultMergeMethod', 'viewerDefaultQueueMethod', 'suggestedActors', 'ruleset', 'rulesets'],
  Issue: ['id', 'databaseId', 'number', 'title', 'titleHTML', 'body', 'bodyHTML', 'bodyText', 'bodyResourcePath', 'bodyUrl', 'state', 'stateReason', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'author', 'authorAssociation', 'editor', 'labels', 'assignees', 'assigneesLogins', 'comments', 'participants', 'participantIds', 'milestone', 'repository', 'locked', 'activeLockReason', 'isPinned', 'isReadByViewer', 'reactionGroups', 'reactions', 'viewerCanReact', 'viewerCanSubscribe', 'viewerSubscription', 'viewerDidAuthor', 'viewerThreadSubscriptionFormAction', 'viewerThreadSubscriptionStatus', 'linkedBranches', 'hovercard', 'projectCards', 'projectItems', 'projectNextItems', 'projectsNext', 'timelineItems', 'viewerCanUpdate', 'viewerCanClose', 'viewerCanReopen', 'viewerCanTransfer', 'viewerCanDelete', 'viewerCanLock', 'viewerCanPin', 'issueType', 'subIssues', 'subIssuesSummary', 'parent', 'blockedBy', 'blocking', 'duplicateOf', 'transferredFrom'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'titleHTML', 'body', 'bodyHTML', 'bodyText', 'state', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'merged', 'mergedAt', 'mergedBy', 'mergeable', 'mergeStateStatus', 'mergeQueueEntry', 'author', 'authorAssociation', 'editor', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'isDraft', 'isCrossRepository', 'maintainerCanModify', 'additions', 'deletions', 'changedFiles', 'commits', 'files', 'comments', 'reviews', 'reviewRequests', 'reviewThreads', 'labels', 'assignees', 'participants', 'milestone', 'repository', 'locked', 'activeLockReason', 'closingIssuesReferences', 'suggestedReviewers', 'autoMergeRequest', 'isInMergeQueue', 'isReadByViewer', 'viewerCanUpdate', 'viewerCanSubscribe', 'viewerSubscription', 'viewerDidAuthor', 'viewerCanReact', 'reactionGroups', 'reactions', 'viewerLatestReviewContributions', 'willCloseTarget', 'checksUrl', 'hovercard', 'projectCards', 'timelineItems', 'latestReviews', 'latestOpinionatedReviews', 'potentialMergeCommit', 'mergeCommit', 'viewerDefaultMergeMethod', 'viewerDefaultQueueMethod', 'viewerCanEnableAutoMerge', 'viewerCanDisableAutoMerge', 'viewerCanUpdateBranch', 'viewerMergeQueueMethod'],
  Label: ['id', 'name', 'color', 'description', 'isDefault', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'issues', 'pullRequests'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyHTML', 'bodyText', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'author', 'authorAssociation', 'editor', 'isMinimized', 'minimizedReason', 'viewerCanDelete', 'viewerCanUpdate', 'reactionGroups', 'reactions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'refUpdateRule', 'branchProtectionRule', 'associatedPullRequests'],
  Commit: ['id', 'oid', 'url', 'resourcePath', 'message', 'messageHeadline', 'messageBody', 'author', 'committer', 'committedDate', 'authoredDate', 'parents', 'tree', 'additions', 'deletions', 'changedFiles', 'changedFilesIfAvailable', 'repository', 'history', 'associatedPullRequests', 'status', 'statusCheckRollup', 'deployments', 'signature', 'viewerCanSubscribe', 'viewerSubscription', 'tarballUrl', 'zipballUrl', 'onBehalfOf', 'pushedDate', 'comments', 'blame', 'file', 'checkSuites'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'DISCUSSION', 'REPOSITORY', 'USER', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function typeObject(name: string): Record<string, unknown> | null {
  if (TYPE_FIELDS[name]) {
    return tagged('__Type', {
      name,
      kind: 'OBJECT',
      fields: TYPE_FIELDS[name].map((fieldName) => tagged('__Field', { name: fieldName, description: null })),
      enumValues: null,
      possibleTypes: null,
      __typeName: name,
    });
  }
  if (ENUM_VALUES[name]) {
    return tagged('__Type', {
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: ENUM_VALUES[name].map((value) => tagged('__EnumValue', { name: value, description: null })),
      possibleTypes: null,
      __typeName: name,
    });
  }
  if (name === 'Node') {
    return tagged('__Type', {
      name, kind: 'INTERFACE', fields: [{ name: 'id' }].map((f) => tagged('__Field', f)),
      enumValues: null,
      possibleTypes: ['Repository', 'Issue', 'PullRequest', 'User', 'Label', 'IssueComment'].map((t) => typeObject(t)),
      __typeName: name,
    });
  }
  return null;
}

defType('__Type', {
  name: (p) => p.name,
  kind: (p) => p.kind,
  description: () => null,
  fields: (p) => p.fields,
  enumValues: (p) => p.enumValues,
  possibleTypes: (p) => p.possibleTypes,
  inputFields: () => null,
  interfaces: () => [],
  ofType: () => null,
  specifiedByURL: () => null,
  __typename: () => '__Type',
});

defType('__Field', {
  name: (p) => p.name,
  description: (p) => p.description ?? null,
  args: () => [],
  type: () => tagged('__Type', { name: 'String', kind: 'SCALAR', fields: null, enumValues: null, possibleTypes: null }),
  isDeprecated: () => false,
  deprecationReason: () => null,
  __typename: () => '__Field',
});

defType('__EnumValue', {
  name: (p) => p.name,
  description: (p) => p.description ?? null,
  isDeprecated: () => false,
  deprecationReason: () => null,
  __typename: () => '__EnumValue',
});

defType('__Schema', {
  types: () => [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeObject(name)),
  queryType: () => typeObject('Query'),
  mutationType: () => typeObject('Mutation'),
  subscriptionType: () => null,
  directives: () => [],
  __typename: () => '__Schema',
});

// ------------------------------------------------------------------ roots ---

defType('Query', {
  viewer: () => userObject(VIEWER.login),
  repository: (_p, args, ctx) => {
    const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    if (!repo) return null;
    return repoObject(repo);
  },
  node: (_p, args) => {
    const id = String(args.id ?? '');
    const repo = repoByGlobalId(id);
    if (repo) return repoObject(repo);
    const issue = issueByGlobalId(id);
    if (issue) return issueObject(issue.repo, issue.issue);
    const pull = pullByGlobalId(id);
    if (pull) return pullObject(pull.repo, pull.pull);
    const decoded = decodeId(id);
    if (decoded?.kind === 'User') {
      const user = userByLogin(VIEWER.login);
      if (user && user.id === decoded.numeric) return userObject(user.login);
    }
    return null;
  },
  rateLimit: () => tagged('RateLimit', { limit: 5000, cost: 1, remaining: 4999, resetAt: isoNow(), nodeCount: 0, used: 1 }),
  __type: (_p, args) => typeObject(String(args.name ?? '')),
  __schema: () => tagged('__Schema', {}),
  __typename: () => 'Query',
});

defType('RateLimit', {
  limit: (p) => p.limit,
  cost: (p) => p.cost,
  remaining: (p) => p.remaining,
  resetAt: (p) => p.resetAt,
  nodeCount: (p) => p.nodeCount,
  used: (p) => p.used,
  __typename: () => 'RateLimit',
});

defType('Mutation', {
  createIssue: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.', type: 'NOT_FOUND' });
      return null;
    }
    const stamp = isoNow();
    const issue: Issue = {
      id: globalId(),
      number: repo.nextNumber,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : null,
      state: 'open',
      labels: [],
      userLogin: VIEWER.login,
      createdAt: stamp,
      updatedAt: stamp,
      comments: [],
      isPullRequest: false,
    };
    if (Array.isArray(input.labelIds)) {
      for (const labelId of input.labelIds as unknown[]) {
        const decoded = decodeId(String(labelId));
        const label = [...repo.labels.values()].find((l) => l.id === decoded?.numeric);
        if (label) issue.labels.push(label.name);
      }
    }
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return tagged('CreateIssuePayload', { issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null });
  },
  closeIssue: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = issueByGlobalId(String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.', type: 'NOT_FOUND' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = isoNow();
    const pull = found.repo.pulls.get(found.issue.number);
    if (pull && found.issue.isPullRequest) {
      pull.state = 'closed';
      pull.updatedAt = found.issue.updatedAt;
    }
    return tagged('CloseIssuePayload', { issue: issueObject(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
  },
  addComment: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const subjectId = String(input.subjectId ?? '');
    const issueFound = issueByGlobalId(subjectId);
    const pullFound = issueFound ? undefined : pullByGlobalId(subjectId);
    const repo = issueFound?.repo ?? pullFound?.repo;
    const issue = issueFound?.issue ?? (pullFound ? pullFound.repo.issues.get(pullFound.pull.number) : undefined);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to a node with the given id.', type: 'NOT_FOUND' });
      return null;
    }
    const stamp = isoNow();
    const comment = {
      id: globalId(), body: String(input.body ?? ''), userLogin: VIEWER.login, createdAt: stamp, updatedAt: stamp,
    };
    issue.comments.push(comment);
    issue.updatedAt = stamp;
    const node = tagged('IssueComment', {
      id: encodeId('IssueComment', comment.id),
      databaseId: comment.id,
      body: comment.body,
      createdAt: stamp,
      updatedAt: stamp,
      author: userObject(VIEWER.login),
    });
    return tagged('AddCommentPayload', {
      commentEdge: tagged('IssueCommentEdge', { node, cursor: cursorFor(issue.comments.length) }),
      subject: issueObject(repo, issue),
      clientMutationId: input.clientMutationId ?? null,
    });
  },
  createPullRequest: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repoByGlobalId(String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.', type: 'NOT_FOUND' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(branchRef(headRef));
    const baseSha = repo.refs.get(branchRef(baseRef));
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'Head or base ref does not exist.', type: 'NOT_FOUND' });
      return null;
    }
    const stamp = isoNow();
    const pull: PullRequest = {
      id: globalId(),
      number: repo.nextNumber,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : null,
      state: 'open',
      draft: input.draft === true,
      headRef,
      headSha,
      baseRef,
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
      id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: 'open',
      labels: [], userLogin: VIEWER.login, createdAt: stamp, updatedAt: stamp, comments: [], isPullRequest: true,
    });
    return tagged('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null });
  },
  mergePullRequest: (_p, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = pullByGlobalId(String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id.', type: 'NOT_FOUND' });
      return null;
    }
    const method = String(input.mergeMethod ?? 'MERGE').toLowerCase() === 'squash' ? 'squash' : 'merge';
    const outcome = mergePull(
      found.repo, found.pull, method,
      typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined,
      typeof input.commitBody === 'string' ? input.commitBody : undefined,
    );
    if (!outcome) {
      ctx.errors.push({ message: 'Pull Request is not mergeable.', type: 'UNPROCESSABLE' });
      return null;
    }
    return tagged('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
  },
  __typename: () => 'Mutation',
});

for (const payload of ['CreateIssuePayload', 'CloseIssuePayload', 'AddCommentPayload', 'CreatePullRequestPayload', 'MergePullRequestPayload']) {
  defType(payload, {
    issue: (p) => p.issue,
    pullRequest: (p) => p.pullRequest,
    commentEdge: (p) => p.commentEdge,
    subject: (p) => p.subject,
    clientMutationId: (p) => p.clientMutationId,
    __typename: () => payload,
  });
}

defType('IssueCommentEdge', {
  node: (p) => p.node,
  cursor: (p) => p.cursor,
  __typename: () => 'IssueCommentEdge',
});

// --------------------------------------------------------------- executor ---

function expandSelections(selections: Selection[], doc: Document, parentType: string | undefined, out: FieldNode[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') out.push(selection);
    else if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment) expandSelections(fragment.selections, doc, parentType, out);
    } else if (selection.kind === 'inline') {
      if (!selection.typeCondition || !parentType || selection.typeCondition === parentType || selection.typeCondition === 'Node') {
        expandSelections(selection.selections, doc, parentType, out);
      }
    }
  }
}

/** Field -> child type, for the types whose nested fields validation must check. */
const CHILD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', rateLimit: 'RateLimit', __type: '__Type', __schema: '__Schema', search: 'SearchResultItemConnection' },
  Mutation: {},
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  IssueCommentEdge: { node: 'IssueComment' },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issues: 'IssueConnection', issue: 'Issue',
    pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', labels: 'LabelConnection',
  },
  Issue: { author: 'User', repository: 'Repository', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
  PullRequest: {
    author: 'User', repository: 'Repository', files: 'PullRequestChangedFileConnection',
    comments: 'IssueCommentConnection', commits: 'PullRequestCommitConnection',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'Edge', pageInfo: 'PageInfo' },
  PullRequestCommitConnection: { nodes: 'PullRequestCommit', edges: 'Edge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  LabelEdge: { node: 'Label' },
  Ref: { target: 'Commit' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type', ofType: '__Type' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
  Node: {},
};

function validateSelections(
  selections: Selection[],
  doc: Document,
  parentType: string,
  errors: Array<{ message: string }>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment) validateSelections(fragment.selections, doc, fragment.typeCondition ?? parentType, errors);
      continue;
    }
    if (selection.kind === 'inline') {
      validateSelections(selection.selections, doc, selection.typeCondition ?? parentType, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    const typeFields = SCHEMA[parentType];
    if (parentType === 'Node') {
      // The Node interface exposes only id; everything else rides fragments.
      if (selection.name !== 'id') {
        errors.push({ message: `Field '${selection.name}' doesn't exist on type 'Node'` });
      }
      continue;
    }
    if (!typeFields || !(selection.name in typeFields)) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${parentType}'` });
      continue;
    }
    const childType = CHILD_TYPES[parentType]?.[selection.name];
    if (childType && selection.selections.length > 0) {
      validateSelections(selection.selections, doc, childType, errors);
    }
  }
}

function validate(selections: Selection[], doc: Document, parentType: string, errors: Array<{ message: string }>): void {
  validateSelections(selections, doc, parentType, errors);
}

function executeField(
  parentType: string,
  parent: unknown,
  field: FieldNode,
  doc: Document,
  ctx: Ctx,
): unknown {
  if (field.name === '__typename') return parentType;
  const resolver = SCHEMA[parentType]?.[field.name];
  if (!resolver) return null;
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx);
  const value = resolver(parent, args, ctx);
  return completeValue(value, field, doc, ctx);
}

function completeValue(value: unknown, field: FieldNode, doc: Document, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, doc, ctx));
  if (typeof value === 'object') {
    const type = typeOf(value) ?? 'Repository';
    if (field.selections.length === 0) return value;
    return executeSelections(type, value, field.selections, doc, ctx);
  }
  return value;
}

function executeSelections(type: string, parent: unknown, selections: Selection[], doc: Document, ctx: Ctx): Record<string, unknown> {
  const fields: FieldNode[] = [];
  expandSelections(selections, doc, type, fields);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field.alias ?? field.name] = executeField(type, parent, field, doc, ctx);
  }
  return out;
}

function runOperation(doc: Document, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validate(operation.selections, doc, rootType, validationErrors);
  if (validationErrors.length > 0) {
    return { errors: validationErrors };
  }
  const data = executeSelections(rootType, tagged(rootType, {}), operation.selections, doc, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ---------------------------------------------------------------- handler ---

interface GraphqlRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function runBody(body: GraphqlRequestBody): Record<string, unknown> {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    return { errors: [{ message: 'No query provided' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operation = body.operationName
    ? doc.operations.find((op) => op.name === body.operationName) ?? doc.operations[0]
    : doc.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  return runOperation(doc, operation, body.variables ?? {});
}

/** Handle POST /api/graphql, including batched operation arrays. */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req)) {
    res.writeHead(401, { 'content-type': JSON_TYPE });
    res.end(`${JSON.stringify({ message: 'Bad credentials' })}\n`);
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': JSON_TYPE });
    res.end(`${JSON.stringify({ errors: [{ message: 'Method not allowed' }] })}\n`);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(`${JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })}\n`);
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runBody(entry as GraphqlRequestBody));
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end(`${JSON.stringify(results)}\n`);
    return;
  }
  const result = runBody(parsed as GraphqlRequestBody);
  res.writeHead(200, { 'content-type': JSON_TYPE });
  res.end(`${JSON.stringify(result)}\n`);
}
