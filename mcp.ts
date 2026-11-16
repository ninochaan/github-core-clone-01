// The MCP endpoint: Model Context Protocol over streamable HTTP, in both
// eras the suite speaks — the modern `server/discover` revision and the
// legacy `initialize` handshake. The tools are the github-mcp-server set the
// competition names, and they act on the same forge state as REST, so an
// object created here is the same object REST reads back.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER, branchRef, createRepo, getRepo, globalId, isoNow, type Issue, type PullRequest,
} from './forge.ts';
import { isAncestor } from './gitstore.ts';
import { tokenOk } from './gitproto.ts';
import { issueJson, mergePull, pullJson } from './social.ts';
import { repoJson } from './restutil.ts';
import { badCredentials, readBody } from './webutil.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const JSON_TYPE = 'application/json; charset=utf-8';

// ------------------------------------------------------------------ tools ---

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
      labels: { type: 'array', description: 'Label names to attach' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'open, closed or all (default open)' },
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    required: ['owner', 'repo', 'issue_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      issue_number: { type: 'number', description: 'The issue number' },
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    required: ['owner', 'repo', 'issue_number', 'body'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      issue_number: { type: 'number', description: 'The issue number' },
      body: { type: 'string', description: 'The comment body' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
      draft: { type: 'boolean', description: 'Whether the pull request is a draft' },
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'open, closed or all (default open)' },
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
      merge_method: { type: 'string', description: 'merge or squash (default merge)' },
      commit_title: { type: 'string', description: 'The merge commit title' },
      commit_message: { type: 'string', description: 'The merge commit message' },
    },
  },
];

function toolsList(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

// -------------------------------------------------------------- execution ---

interface ToolOutcome {
  value: unknown;
  isError?: boolean;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function num(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  return typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
}

function runTool(req: IncomingMessage, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args, 'name');
      if (getRepo(VIEWER.login, repoName)) return { value: `Repository ${repoName} already exists`, isError: true };
      const repo = createRepo(VIEWER.login, repoName, {
        description: str(args, 'description') || null,
        isPrivate: args.private === true,
      });
      return { value: repoJson(req, repo) };
    }
    case 'get_repo': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      if (!repo) return { value: 'Repository not found', isError: true };
      return { value: repoJson(req, repo) };
    }
    case 'create_issue': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      if (!repo) return { value: 'Repository not found', isError: true };
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return { value: `Label '${label}' does not exist`, isError: true };
      }
      const stamp = isoNow();
      const issue: Issue = {
        id: globalId(),
        number: repo.nextNumber,
        title: str(args, 'title'),
        body: str(args, 'body') || null,
        state: 'open',
        labels,
        userLogin: VIEWER.login,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
        isPullRequest: false,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { value: issueJson(req, repo, issue) };
    }
    case 'list_issues': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      if (!repo) return { value: 'Repository not found', isError: true };
      const state = str(args, 'state') || 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return { value: list.map((issue) => issueJson(req, repo, issue)) };
    }
    case 'get_issue': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      const issue = repo?.issues.get(num(args, 'issue_number'));
      if (!repo || !issue) return { value: 'Issue not found', isError: true };
      return { value: issueJson(req, repo, issue) };
    }
    case 'add_issue_comment': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      const issue = repo?.issues.get(num(args, 'issue_number'));
      if (!repo || !issue) return { value: 'Issue not found', isError: true };
      const stamp = isoNow();
      const comment = {
        id: globalId(), body: str(args, 'body'), userLogin: VIEWER.login, createdAt: stamp, updatedAt: stamp,
      };
      issue.comments.push(comment);
      issue.updatedAt = stamp;
      return { value: { id: comment.id, body: comment.body, created_at: stamp, updated_at: stamp } };
    }
    case 'create_pull_request': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      if (!repo) return { value: 'Repository not found', isError: true };
      const head = str(args, 'head').replace(new RegExp(`^${repo.owner}:`), '');
      const baseRef = str(args, 'base').replace(new RegExp(`^${repo.owner}:`), '');
      const headSha = repo.refs.get(branchRef(head));
      const baseSha = repo.refs.get(branchRef(baseRef));
      if (!headSha || !baseSha) return { value: 'Head or base branch not found', isError: true };
      if (isAncestor(headSha, baseSha)) return { value: 'No commits between base and head', isError: true };
      const stamp = isoNow();
      const pull: PullRequest = {
        id: globalId(),
        number: repo.nextNumber,
        title: str(args, 'title'),
        body: str(args, 'body') || null,
        state: 'open',
        draft: args.draft === true,
        headRef: head,
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
      return { value: pullJson(req, repo, pull) };
    }
    case 'list_pull_requests': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      if (!repo) return { value: 'Repository not found', isError: true };
      const state = str(args, 'state') || 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return { value: list.map((pull) => pullJson(req, repo, pull)) };
    }
    case 'get_pull_request': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      const pull = repo?.pulls.get(num(args, 'pull_number'));
      if (!repo || !pull) return { value: 'Pull request not found', isError: true };
      return { value: pullJson(req, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = getRepo(str(args, 'owner'), str(args, 'repo'));
      const pull = repo?.pulls.get(num(args, 'pull_number'));
      if (!repo || !pull) return { value: 'Pull request not found', isError: true };
      if (pull.merged) return { value: 'Pull Request has already been merged', isError: true };
      const method = str(args, 'merge_method') === 'squash' ? 'squash' : 'merge';
      const outcome = mergePull(repo, pull, method, str(args, 'commit_title') || undefined, str(args, 'commit_message') || undefined);
      if (!outcome) return { value: 'Pull Request is not mergeable', isError: true };
      return { value: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    default:
      return { value: `Unknown tool ${name}`, isError: true };
  }
}

// -------------------------------------------------------------- JSON-RPC ----

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function dispatch(req: IncomingMessage, call: RpcRequest): Record<string, unknown> | undefined {
  const id = call.id;
  const method = call.method ?? '';
  const params = call.params ?? {};
  if (id === undefined) {
    // A notification: accepted, never answered.
    return undefined;
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
        protocolVersion: SUPPORTED_VERSIONS[0],
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcResult(id, {
            content: [{ type: 'text', text: `Missing required argument: ${required}` }],
            isError: true,
          });
        }
      }
      const outcome = runTool(req, name, args);
      const result: Record<string, unknown> = {
        content: [{ type: 'text', text: typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value) }],
        isError: outcome.isError === true,
      };
      if (typeof outcome.value !== 'string') result.structuredContent = outcome.value;
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle POST /mcp (and reject everything else on the path). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!tokenOk(req)) {
    badCredentials(res);
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': JSON_TYPE, allow: 'POST' });
    res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } })}\n`);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((call) => dispatch(req, call as RpcRequest))
      .filter((r): r is Record<string, unknown> => r !== undefined);
    res.writeHead(200, { 'content-type': JSON_TYPE });
    res.end(`${JSON.stringify(responses)}\n`);
    return;
  }
  const response = dispatch(req, parsed as RpcRequest);
  if (response === undefined) {
    res.writeHead(202, { 'content-type': JSON_TYPE });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': JSON_TYPE });
  res.end(`${JSON.stringify(response)}\n`);
}
