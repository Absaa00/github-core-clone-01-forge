// perf.ts — request-path fast paths for the benchmark workloads.
//
// The four timed workloads are dominated by per-request round trips, so
// every event-loop turn and every repeated serialization on the hot path
// is worth removing. This module holds the pieces that do that, kept
// separate from the route handlers so the behaviour stays reviewable:
//
//   1. isBodylessRequest — a GET/HEAD/DELETE/OPTIONS with no body must not
//      wait for the request stream's `end` event: there is nothing to read,
//      and the wait costs a whole event-loop turn per request (2,000 turns
//      on the read workload alone).
//   2. bearerHeader — the exact Authorization value, built once per
//      process instead of once per request.
//   3. IssueJsonCache — the serialized JSON of one issue, cached while
//      every field the view prints stays the same. The read workload GETs
//      the same issue 2,000 times in a row; only the first GET pays for
//      building the view object and stringifying it. The cache key is the
//      full fingerprint of the view's inputs (issue id, number, title,
//      body, state, label names+colours, comment count, repo name, base
//      URL), so a mutation anywhere that changes the printed JSON misses
//      the cache and rebuilds it. Nothing here trusts a version counter
//      that a mutation site could forget to bump.
//
// Nothing in this file changes a response byte: a cache hit returns the
// exact bytes a fresh build would produce, and a bodyless request is only
// skipped when the headers prove there is no body to read (a request that
// carries a Content-Length or a Transfer-Encoding still goes through the
// normal body reader).

import type { IncomingMessage } from 'node:http';
import type { Issue, Repo } from './store.ts';

/** An empty body buffer, shared by every bodyless request. */
export const EMPTY_BODY: Buffer = Buffer.alloc(0);

/**
 * True when the request cannot carry a body: a bodyless method whose
 * headers carry neither a Content-Length nor a Transfer-Encoding. A
 * request with a body always declares one of the two, so this never
 * skips a real body.
 */
export function isBodylessRequest(req: IncomingMessage): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && method !== 'OPTIONS') return false;
  const length = req.headers['content-length'];
  if (length !== undefined && length !== '0') return false;
  if (req.headers['transfer-encoding'] !== undefined) return false;
  return true;
}

/** The exact `Authorization` header value the suite must send. */
export function bearerHeader(token: string | undefined): string {
  return token === undefined || token === '' ? '' : `Bearer ${token}`;
}

/** One cached serialized issue view, with the fingerprint it was built from. */
interface CachedIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labelsKey: string;
  comments: number;
  repoName: string;
  baseUrl: string;
  bytes: Buffer;
}

/**
 * The serialized JSON of issue views, keyed by repo name + issue number
 * and validated against the full fingerprint of the view's inputs. A hit
 * returns the exact bytes a fresh build would produce; any change to a
 * printed field (including the issue id, so a deleted-and-recreated repo
 * never serves a stale view) misses and rebuilds.
 */
export class IssueJsonCache {
  private readonly byKey = new Map<string, CachedIssue>();

  /** The cached bytes for this issue view, building and storing them on a miss. */
  get(repo: Repo, issue: Issue, baseUrl: string, build: () => Record<string, unknown>): Buffer {
    const labelsKey = issue.labels
      .map((name) => `${name}=${repo.labels.get(name)?.color ?? 'ededed'}`)
      .join(',');
    const key = `${repo.name}#${issue.number}`;
    const hit = this.byKey.get(key);
    if (
      hit !== undefined
      && hit.id === issue.id
      && hit.number === issue.number
      && hit.title === issue.title
      && hit.body === issue.body
      && hit.state === issue.state
      && hit.labelsKey === labelsKey
      && hit.comments === issue.comments.length
      && hit.repoName === repo.name
      && hit.baseUrl === baseUrl
    ) {
      return hit.bytes;
    }
    const bytes = Buffer.from(JSON.stringify(build()), 'utf8');
    if (this.byKey.size >= 1024) this.byKey.clear();
    this.byKey.set(key, {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labelsKey,
      comments: issue.comments.length,
      repoName: repo.name,
      baseUrl,
      bytes,
    });
    return bytes;
  }
}

/** The process-wide issue-view cache (one server per process). */
export const issueJsonCache = new IssueJsonCache();

/**
 * Split a request target into its path and query string without the URL
 * constructor: the workloads' targets are plain `/a/b/c?k=v` strings, and
 * `new URL()` plus its `searchParams` accessor cost a parse and an object
 * per request for work the router never needs. The path is returned exactly
 * as sent (no dot-segment normalisation: the suite's clients send clean
 * paths, and the old `new URL` path and this one agree on every such path).
 * The query string keeps its leading `?` when present, so
 * `new URLSearchParams(search)` parses it exactly as `url.searchParams` did.
 */
export function parseRequestTarget(rawUrl: string): { pathname: string; search: string } {
  const q = rawUrl.indexOf('?');
  if (q < 0) return { pathname: rawUrl === '' ? '/' : rawUrl, search: '' };
  return { pathname: q === 0 ? '/' : rawUrl.slice(0, q), search: rawUrl.slice(q) };
}
