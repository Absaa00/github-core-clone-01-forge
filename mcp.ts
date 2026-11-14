// mcp.ts — the Model Context Protocol endpoint at POST /mcp.
//
// Two protocol eras, one handler (verified against the kit's mcp-client.ts
// and checks-mcp.ts):
//   - modern 2026-07-28: no handshake; every request declares its revision
//     in `_meta['io.modelcontextprotocol/protocolVersion']`; `server/discover`
//     answers identity, capabilities and `supportedVersions` in one call,
//     with the server info also mirrored under
//     `_meta['io.modelcontextprotocol/serverInfo']`.
//   - legacy 2025-11-25 and earlier: `initialize` (echoing the negotiated
//     protocolVersion) + `notifications/initialized`; an optional
//     `Mcp-Session-Id` — this server never issues one and never reads one.
//   - `tools/list` returns the same frozen tool array on every call
//     (byte-identical); six canonical tools, each with a non-empty
//     description and `inputSchema: {type: "object", properties, required}`
//     whose required properties the suite can fill via its synonym map.
//   - `tools/call` answers `{content: [{type: "text", text: "<JSON>"}],
//     structuredContent: <same>, isError: false}`; an unknown tool is a
//     JSON-RPC error -32602 (never HTTP 500); missing required arguments
//     are `isError: true`; every request's own `id` is echoed back.
//   - a body that is not JSON answers HTTP 400 with JSON-RPC -32700.
//   - DELETE /mcp is accepted (legacy session close, best-effort).
//   - no auth -> exactly 401 (the router enforces that).

import { ApiError, Store, VIEWER, type Repo } from './store.ts';
import { FIXED_ISO } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** What an MCP handler answers: HTTP status plus the body to serialize. */
export interface McpAnswer {
  readonly status: number;
  readonly body: unknown;
}

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

// ---------------------------------------------------------------------------
// tools (frozen: tools/list must be byte-identical across calls)
// ---------------------------------------------------------------------------

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description: string }>>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly McpToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch the changes come from.' },
        base: { type: 'string', description: 'The branch the changes go into.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

// ---------------------------------------------------------------------------
// tool implementations (all on the shared store)
// ---------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function requireRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = String(args['owner'] ?? '');
  const repo = String(args['repo'] ?? '');
  const found = store.getRepo(owner, repo);
  if (found === undefined) throw new ApiError(404, `repository ${owner}/${repo} not found`);
  return found;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function runTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === '') throw new ApiError(422, 'name is required');
      const created = store.createRepo(repoName, args['private'] === true, stringArg(args, 'description'));
      if (created === null) throw new ApiError(422, `repository ${repoName} already exists`);
      return repoView(created);
    }
    case 'get_repo': {
      return repoView(requireRepo(store, args));
    }
    case 'create_issue': {
      const repo = requireRepo(store, args);
      const title = stringArg(args, 'title');
      if (title === '') throw new ApiError(422, 'title is required');
      const issue = store.createIssue(repo, title, stringArg(args, 'body'));
      return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, created_at: FIXED_ISO };
    }
    case 'list_issues': {
      const repo = requireRepo(store, args);
      const state = stringArg(args, 'state') || 'open';
      return store.listIssues(repo, state, 'desc').map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: FIXED_ISO,
      }));
    }
    case 'create_pull_request': {
      const repo = requireRepo(store, args);
      const pull = store.createPull(
        repo,
        stringArg(args, 'head'),
        stringArg(args, 'base'),
        stringArg(args, 'title'),
        stringArg(args, 'body'),
      );
      return {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: pull.headRef,
        base: pull.baseRef,
        created_at: FIXED_ISO,
      };
    }
    case 'merge_pull_request': {
      const repo = requireRepo(store, args);
      const number = Number(args['pull_number']);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ApiError(404, `pull request #${number} not found`);
      const mergeSha = store.mergePull(repo, pull);
      return { number: pull.number, merged: true, state: 'closed', merge_commit_sha: mergeSha };
    }
    default:
      throw new ApiError(404, `unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------

/**
 * Handle one request to /mcp. `rawBody` is the request bytes (parsed here
 * so a malformed body can answer HTTP 400 with JSON-RPC -32700).
 * DELETE is accepted and answers 200 with an empty body.
 */
export function handleMcp(store: Store, method: string, rawBody: Buffer): McpAnswer {
  if (method === 'DELETE') return { status: 200, body: '' };
  if (method !== 'POST') return { status: 405, body: rpcError(null, -32601, `method ${method} not supported on /mcp`) };

  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const { method: rpcMethod, id, params } = request as { method?: unknown; id?: unknown; params?: unknown };
  const isNotification = id === undefined;

  if (typeof rpcMethod !== 'string') {
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  }

  switch (rpcMethod) {
    case 'server/discover': {
      const info = serverInfo();
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: info,
          _meta: { 'io.modelcontextprotocol/serverInfo': info },
        }),
      };
    }
    case 'initialize': {
      const offered = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const negotiated =
        typeof offered === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        }),
      };
    }
    case 'notifications/initialized': {
      // A notification: no JSON-RPC response. 202, empty body.
      return { status: 202, body: '' };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    }
    case 'tools/call': {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const toolName = typeof callParams.name === 'string' ? callParams.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        return { status: 200, body: rpcError(id, -32602, `unknown tool ${JSON.stringify(toolName)}`) };
      }
      const args = (callParams.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
      if (missing.length > 0) {
        return { status: 200, body: rpcResult(id, toolError(`missing required argument(s): ${missing.join(', ')}`)) };
      }
      try {
        return { status: 200, body: rpcResult(id, toolResult(runTool(store, toolName, args))) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 200, body: rpcResult(id, toolError(message)) };
      }
    }
    default: {
      if (isNotification) return { status: 202, body: '' };
      return { status: 200, body: rpcError(id, -32601, `method ${JSON.stringify(rpcMethod)} not found`) };
    }
  }
}
