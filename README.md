# github-core-clone-01-forge

A GitHub-core clone for the make.fun `github-core-clone-01` competition: one
deterministic in-memory forge serving the REST API, the GraphQL API, the MCP
endpoint, and git smart HTTP — all over the same store, all without a git
binary, a database, or any network beyond the trial env.

## Run

```sh
npm start   # node --experimental-strip-types main.ts
```

The process needs two environment variables from the trial env:

- `MAKEFUN_ENV_URL` — the env origin to register with (`/register`, `/done`).
- `MAKEFUN_SHOP_TOKEN` — the bearer token the suite's requests carry.

It binds an ephemeral port (never 8080), POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done`
answers `{"done": true}`, then exits 0.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, serve until done. |
| `app.ts` | The HTTP server: routing, bearer auth, request ids, body limits. |
| `store.ts` | The deterministic store: repos, objects, refs, issues, pulls, Relay ids. |
| `gitobj.ts` | Pure git primitives: objects, trees, commits, tags, packs, deltas. |
| `gitproto.ts` | Git smart HTTP: pkt-lines, v0/v2 advertisements, fetch, receive-pack. |
| `rest.ts` | The GitHub REST surface under `/api/v3`. |
| `graphql.ts` | A hand-written GraphQL executor for `/api/graphql`. |
| `mcp.ts` | The MCP endpoint at `/mcp` (2026-07-28 discover + legacy initialize). |
| `util.ts` | SHA-1, base64url, the fixed scenario clock, small helpers. |

## Rules the forge lives by

- **Deterministic.** Every timestamp is the fixed scenario instant
  (`2025-01-01T00:00:00Z`); commit identity advances a counter, never the
  wall clock. Two runs of the same trial produce the same bytes.
- **One store.** REST, GraphQL, MCP and git all read and write the same
  `Store`, so a pull request opened over GraphQL reads back over REST, and
  a branch pushed over git lists in the API.
- **Verified protocol.** Git advertisements, fetch acknowledgments, shallow
  boundaries, sideband packs and fast-forward rules follow the wire format
  git itself speaks; the REST and GraphQL shapes follow the gh CLI's
  documents.
- **Fast.** Deflated object bytes are cached by oid, whole fetch packs are
  cached by (repo, wants, haves, shallow, depth, object count), and no hot
  path scans the object store linearly.
- **Safe.** Value never leaves the process: no payments, no signing, no
  network beyond the env, no seed phrases, no credentials in code.
