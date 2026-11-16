# Forge — a GitHub-compatible git forge in one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ninochaan/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ninochaan/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An entry for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) on make.fun: a standalone GitHub-compatible git forge with no UI and no dependencies — one Node process that serves git smart HTTP, the REST v3 API, GraphQL v4 and an MCP endpoint from its own in-memory object store.

## What it implements

- **Git smart HTTP** (`gitproto.ts`, `pack.ts`, `gitstore.ts`) — a content-addressed object store (loose-object SHA-1 semantics), pack parse/build with OFS/REF delta resolution, protocol v0 and v2 advertisements, ls-refs with ref-prefix/peel/symrefs/unborn, fetch with shallow/deepen/unshallow and include-tag, and receive-pack with fast-forward rules and per-ref report-status. Real `git clone`, `push`, `pull`, `--depth` and annotated tags work against it.
- **REST v3** (`app.ts`, `social.ts`) — users, repositories, branches, commits, contents (read/write with real commits), git refs, labels, issues, comments and pull requests with a true three-way merge.
- **GraphQL v4** (`graphql.ts`) — a hand-written lexer, parser and executor covering viewer/repository/node queries, issue and pull-request connections with cursor pagination, introspection, and the create/close/comment/merge mutations.
- **MCP** (`mcp.ts`) — JSON-RPC tool calls (`create_repo`, `create_issue`, `create_pull_request`, `merge_pull_request`, …) acting on the same forge state as the other surfaces.

Everything is deterministic: object ids are content hashes, timestamps derive from the trial clock, and response ids are seeded — the same request sequence replays byte-identically.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports only `node:` builtins and its own modules, and the trial has no package manager and no internet.

## Layout

- `main.ts` — the lifecycle the harness drives (kept from the starter).
- `app.ts` — HTTP routing and the REST v3 resources.
- `forge.ts` — forge state: users, repositories, the trial clock.
- `gitstore.ts` — the object store: trees, commits, reachability, merge bases.
- `pack.ts` — pkt-line codec and pack reading/writing.
- `gitproto.ts` — smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `social.ts` — labels, issues, comments, pull requests, three-way merges.
- `graphql.ts` — the GraphQL schema and executor.
- `mcp.ts` — the MCP endpoint.
- `diff.ts`, `restutil.ts`, `webutil.ts` — unified diffs and HTTP/JSON helpers.

## Licence

MIT — see `LICENSE`.
