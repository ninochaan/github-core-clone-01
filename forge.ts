// The forge's state: repositories and everything the REST, GraphQL and MCP
// surfaces hang off them. Git objects live in gitstore.ts; this module owns
// refs and the social layer (issues, pull requests, labels, comments).
//
// Identity is the trial scenario's: the bearer token names one user, the
// viewer, and every repository created through the API belongs to them. The
// scenario is a published constant of the competition kit (its wire.ts
// generates the same users in every process), so the viewer is a constant
// here too: adaiversen, id 1000.

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User';
}

/** Every user the scenario knows, viewer first (the kit's wire.ts generates this same table). */
export const USERS: ScenarioUser[] = [
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid', type: 'User' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid', type: 'User' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid', type: 'User' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid', type: 'User' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid', type: 'User' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid', type: 'User' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid', type: 'User' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid', type: 'User' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid', type: 'User' },
];

export function userByLogin(login: string): ScenarioUser | undefined {
  return USERS.find((user) => user.login === login);
}

export function userByEmail(email: string): ScenarioUser | undefined {
  return USERS.find((user) => user.email === email);
}

/** The trial clock: MAKEFUN_TRIAL_NOW when the harness sets it, else real time, advanced per call so ordering is stable. */
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ? Date.parse(process.env.MAKEFUN_TRIAL_NOW) : Number.NaN;
let tick = 0;
export function now(): Date {
  tick += 1;
  if (!Number.isNaN(TRIAL_NOW)) return new Date(TRIAL_NOW + tick * 1000);
  return new Date(Date.now() + tick);
}

export function isoNow(): string {
  return now().toISOString();
}

let nextGlobalId = 1;
export function globalId(): number {
  const id = nextGlobalId;
  nextGlobalId += 1;
  return id;
}

// ------------------------------------------------------------ data types ---

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
  isDefault: boolean;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
  isPullRequest: boolean;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
}

const repos = new Map<string, Repo>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(owner: string, name: string, init: { description?: string | null; isPrivate?: boolean; defaultBranch?: string }): Repo {
  const stamp = isoNow();
  const repo: Repo = {
    id: globalId(),
    owner,
    name,
    description: init.description ?? null,
    isPrivate: init.isPrivate ?? false,
    defaultBranch: init.defaultBranch ?? 'main',
    createdAt: stamp,
    updatedAt: stamp,
    refs: new Map(),
    nextNumber: 1,
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function reposOf(owner: string): Repo[] {
  return [...repos.values()].filter((repo) => repo.owner === owner);
}

export function allRepos(): Repo[] {
  return [...repos.values()];
}

/** The full ref name for a branch ('main' -> 'refs/heads/main'). */
export function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** The commit a branch or tag name resolves to, following HEAD. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') {
    const target = repo.refs.get(branchRef(repo.defaultBranch));
    return target;
  }
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return repo.refs.get(branchRef(ref)) ?? repo.refs.get(ref) ?? repo.refs.get(`refs/tags/${ref}`);
}

/** The standard label names the scenario uses; labels exist only once created through the API. */
export const SCENARIO_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'] as const;
