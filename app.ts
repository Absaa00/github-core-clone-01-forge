// app.ts — the HTTP server: one Node http server routing every surface.
//
//   GET  /healthz                    200 {status: "ok"} (unauthenticated)
//   /api/v3/*                        the REST surface (rest.ts)
//   POST /api/graphql                the GraphQL executor (graphql.ts)
//   POST|DELETE /mcp                 the MCP endpoint (mcp.ts)
//   /{owner}/{repo}.git/info/refs    git advertisements (gitproto.ts)
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack
//
// Conventions, all verified against the kit's clients:
//   - auth is `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; a missing or
//     wrong token answers exactly 401 JSON `{message}`. The root document
//     and /meta are the only unauthenticated API routes (healthz too).
//   - every reply carries a non-empty `X-GitHub-Request-Id` header; the
//     request id is a per-process counter, so nothing leaks wall-clock time.
//   - every reply is JSON `{message}` on error, including 404s; git
//     success replies keep their git content type.
//   - bodies are capped at 64 MiB (the largest legitimate body is a
//     history push of a few hundred objects); a malformed JSON body on a
//     JSON route answers 400, except /mcp, which answers HTTP 400 with
//     JSON-RPC -32700 through its own parser.
//   - the base URL for Link headers and repo URLs comes from the request's
//     own Host header, so paginated links stay on the entry's origin.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ApiError, Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';
import { bearerHeader, EMPTY_BODY, isBodylessRequest } from './perf.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendUnauthorized(res: ServerResponse): void {
  // The WWW-Authenticate challenge is what makes a plain git binary retry
  // with the credentials it holds (it never sends them unchallenged).
  sendJson(res, 401, { message: 'authentication required' }, { 'www-authenticate': 'Basic realm="forge"' });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body) ?? '';
  // Content-Length up front: without it Node falls back to chunked
  // encoding, which costs framing on every response.
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send a pre-serialized JSON body (its bytes are already exact). */
function sendRaw(res: ServerResponse, status: number, bytes: Buffer, extraHeaders: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** Parse a JSON body; undefined when the body is empty. Throws ApiError 400. */
function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'malformed JSON body');
  }
}

function authorized(req: IncomingMessage, expectedToken: string | undefined, expectedBearer: string): boolean {
  if (expectedToken === undefined || expectedToken === '') return false;
  const header = req.headers.authorization ?? '';
  if (expectedBearer !== '' && header === expectedBearer) return true;
  // Real git (and curl -u) speak Basic: the token rides as the password,
  // e.g. `https://x-access-token:<token>@host/...`. The suite's own
  // clients always send Bearer; this only makes the forge behave like
  // GitHub for a plain git binary.
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0 && decoded.slice(colon + 1) === expectedToken) return true;
    } catch {
      // Not decodable base64: not authorized.
    }
  }
  return false;
}

/** Build the server. `expectedToken` is the bearer token the suite issued. */
export function createApp(store: Store, expectedToken: string | undefined) {
  const expectedBearer = bearerHeader(expectedToken);
  const server = createServer((req, res) => {
    void handleRequest(store, expectedToken, expectedBearer, req, res).catch((err: unknown) => {
      if (!res.writableEnded) {
        const message = err instanceof Error ? err.message : 'internal error';
        console.error(`[forge] unhandled error: ${message}`);
        sendJson(res, 500, { message: 'internal error' });
      }
    });
  });
  return server;
}

async function handleRequest(
  store: Store,
  expectedToken: string | undefined,
  expectedBearer: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((part) => part !== '');
  const query = url.searchParams;
  // A request that cannot carry a body must not wait for the stream's
  // `end` event: that wait is a whole event-loop turn per request.
  const bodyless = isBodylessRequest(req);

  try {
    // -- health --------------------------------------------------------------
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // -- GraphQL --------------------------------------------------------------
    if (url.pathname === '/api/graphql') {
      if (method !== 'POST') throw new ApiError(404, 'Not Found');
      if (!authorized(req, expectedToken, expectedBearer)) {
        sendUnauthorized(res);
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      const answer = handleGraphQL(store, body);
      sendJson(res, answer.status, answer.body);
      return;
    }

    // -- MCP ------------------------------------------------------------------
    if (url.pathname === '/mcp') {
      if (!authorized(req, expectedToken, expectedBearer)) {
        sendUnauthorized(res);
        return;
      }
      const raw = bodyless ? EMPTY_BODY : await readBody(req);
      const answer = handleMcp(store, method, raw);
      if (answer.body === '') {
        res.writeHead(answer.status, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      sendJson(res, answer.status, answer.body);
      return;
    }

    // -- REST -----------------------------------------------------------------
    if (segments[0] === 'api' && segments[1] === 'v3') {
      const restSegments = segments.slice(2);
      const isRoot = restSegments.length === 0;
      const isMeta = restSegments.length === 1 && restSegments[0] === 'meta';
      if (!isRoot && !isMeta && !authorized(req, expectedToken, expectedBearer)) {
        sendUnauthorized(res);
        return;
      }
      const raw = bodyless ? EMPTY_BODY : await readBody(req);
      const body = parseJsonBody(raw);
      const answer = handleRest(store, method, restSegments, query, body, baseUrl, url.pathname);
      if (answer.status === 204) {
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      if (answer.raw !== undefined) {
        sendRaw(res, answer.status, answer.raw, answer.headers ?? {});
        return;
      }
      sendJson(res, answer.status, answer.body, answer.headers ?? {});
      return;
    }

    // -- git smart HTTP --------------------------------------------------------
    if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
      if (!authorized(req, expectedToken, expectedBearer)) {
        sendUnauthorized(res);
        return;
      }
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      const subpath = segments.slice(2).join('/');
      const headers: Record<string, string | undefined> = {
        'git-protocol': req.headers['git-protocol'],
      };
      const raw = bodyless ? EMPTY_BODY : await readBody(req);
      const answer = handleGit(store, owner, repoName, subpath, method, query, headers, raw);
      sendBytes(res, answer.status, answer.contentType, answer.body);
      return;
    }

    throw new ApiError(404, 'Not Found');
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    throw err;
  }
}
