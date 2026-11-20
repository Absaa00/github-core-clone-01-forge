// gitproto.ts — git smart HTTP: info/refs advertisements, upload-pack
// (protocol v2 and v0) and receive-pack (v0).
//
// The wire rules this file implements, as verified against the suite's own
// client (kit program/env/src/git-client.ts) and git 2.43:
//   - pkt-line framing: `0000` flush, `0001` delim, `0002` response-end,
//     4-hex length prefix, 65520 bytes max per packet.
//   - v2 advertisement: `version 2` first, then capability lines, flush.
//   - v0 advertisement: `# service=...` preamble, flush, ref lines; the
//     first line carries capabilities after a NUL; an empty repo advertises
//     the `capabilities^{}` pseudo-ref; annotated tags get a `^{}` line;
//     the advertisement AND the v0 fetch response end with a flush.
//   - v2 fetch sections, in order: acknowledgments (only when the client
//     sent haves without `done`), shallow-info, packfile; sections split by
//     delim, the response closed by a flush. Shallow-info lines carry no
//     trailing newline; section headers do.
//   - v2 acknowledgments: ACK every have the server holds (bare, request
//     order); `ready` plus the packfile when a held have is an ancestor of
//     a want; `NAK` + flush with no packfile when no have is held; ACKs +
//     flush with no packfile when haves are held but none is an ancestor.
//   - v0 fetch: shallow/unshallow lines first (no trailing newline), then
//     ACK/NAK lines, then the sideband pack, then a flush.
//   - Fetch object selection: closure(wants, depth-limited) minus the
//     closure the client holds, where a declared shallow boundary is
//     included with its tree/blobs but its parents are not walked.
//   - receive-pack: per-ref fast-forward, `unpack ok` + one `ok`/`ng`
//     line per ref inside a band-1 sideband stream; a refused ref never
//     moves, and a non-fast-forward refusal says exactly
//     `non-fast-forward`.
//   - A malformed POST to upload-pack answers 400 and never crashes.
//
// Performance: deflated object bytes are cached by oid (gitobj.ts), and a
// whole fetch pack is cached by (repo, wants, haves, shallow, depth, object
// count) — the object set only grows and is content-addressed, so the count
// fingerprints it exactly.

import {
  collectReachable,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  ZERO_OID,
} from './gitobj.ts';
import { ApiError, Store, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes, then the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new ApiError(400, 'pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Parse pkt-lines from `buf`. Stops at the first flush (returning the offset
 * just past it) when `stopAtFlush` is set — the bytes after it are a raw
 * pack, not pkt-lines. Throws ApiError 400 on a malformed header.
 */
export function parsePktLines(
  buf: Buffer,
  options: { stopAtFlush?: boolean } = {},
): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new ApiError(400, 'truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new ApiError(400, `invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAtFlush === true) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new ApiError(400, `invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new ApiError(400, 'truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The text of every data packet, in order. */
function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// fetch pack cache
// ---------------------------------------------------------------------------

interface CachedFetch {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  /**
   * The fully-assembled v2 pack section (shallow-info + packfile + sideband
   * + flush) for this entry, built once. Only the v2 path uses it; v0
   * responses frame the same pack differently, so entries built by a v0
   * fetch leave this undefined and the v2 path fills it in on first use.
   */
  response?: Buffer;
}

const FETCH_CACHE_MAX = 16;
const fetchCache = new Map<string, CachedFetch>();

function fetchCacheGet(key: string): CachedFetch | undefined {
  return fetchCache.get(key);
}

function fetchCacheSet(key: string, value: CachedFetch): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, value);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

const AGENT = 'forge/1.0';
const UPLOAD_V0_CAPS = `side-band-64k shallow multi_ack_detailed thin-pack ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** Refs of a repo, sorted by name, with peeled targets for annotated tags. */
function repoRefLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const lines: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      entry.peeled = parseTag(object.data).object;
    }
    lines.push(entry);
  }
  return lines;
}

/**
 * The v2 capability advertisement. Constant: the v2 advertisement carries no
 * repo state at all (no refs, no capabilities that vary), so it is built
 * once and shared by every info/refs request.
 */
const ADVERTISEMENT_V2: Buffer = Buffer.concat([
  pkt('version 2\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow wait-for-done filter\n'),
  pkt('object-format=sha1\n'),
  pkt(`agent=${AGENT}\n`),
  FLUSH,
]);

function advertisementV2(): Buffer {
  return ADVERTISEMENT_V2;
}

/**
 * Fingerprint of the ref state a git response depends on. Derived from
 * repoRefLines (sorted, peeled), so ANY ref change (push, branch/tag
 * create/delete, peeled target change) changes the key; object-store growth
 * that does not move a ref leaves it unchanged. Building it is a cheap
 * string join over the (few) refs; the expensive part it avoids is the
 * per-request pkt()/Buffer.concat response assembly.
 */
function fingerprintFromLines(refs: ReadonlyArray<{ oid: string; name: string; peeled?: string }>): string {
  let out = '';
  for (const ref of refs) out += `${ref.oid} ${ref.name}${ref.peeled !== undefined ? `^${ref.peeled}` : ''};`;
  return out;
}

function refsFingerprint(repo: Repo): string {
  return fingerprintFromLines(repoRefLines(repo));
}

/**
 * Cache of fully-assembled ref-dependent git responses (v0 advertisements,
 * ls-refs). Keyed by refs fingerprint + the request inputs that shape the
 * response, so a stale entry is impossible without a fingerprint change.
 * Bounded FIFO like the fetch cache.
 */
const REF_RESPONSE_CACHE_MAX = 64;
const refResponseCache = new Map<string, Buffer>();

function refResponseCacheGet(key: string): Buffer | undefined {
  return refResponseCache.get(key);
}

function refResponseCacheSet(key: string, value: Buffer): void {
  if (refResponseCache.size >= REF_RESPONSE_CACHE_MAX) {
    const oldest = refResponseCache.keys().next().value;
    if (oldest !== undefined) refResponseCache.delete(oldest);
  }
  refResponseCache.set(key, value);
}

/** The v0 advertisement for one service. */
function advertisementV0(
  service: 'git-upload-pack' | 'git-receive-pack',
  repo: Repo,
): Buffer {
  const refs = repoRefLines(repo);
  const key = `v0|${service}|${fingerprintFromLines(refs)}`;
  const hit = refResponseCacheGet(key);
  if (hit !== undefined) return hit;
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const headOid = mainTip ?? refs[0]!.oid;
    parts.push(pkt(`${headOid} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  refResponseCacheSet(key, body);
  return body;
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send (oids). */
  send: Set<string>;
  /** Commits at the depth boundary (new shallow). */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
  /** Want commits (tags peeled). */
  wantCommits: string[];
}

/** Peel a want oid to its commit (tags peel; commits pass through). */
function peelToCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const target = parseTag(object.data).object;
    const targetObject = repo.objects.get(target);
    return targetObject !== undefined && targetObject.type === 'commit' ? target : null;
  }
  return null;
}

/**
 * The depth-limited closure of the wants: generation 1 is each want commit;
 * a commit's tree and blobs are included for generations <= depth, and its
 * parents are walked only while generation < depth. Without a depth the
 * closure is complete. Tag wants contribute the tag object itself.
 */
function wantClosure(
  repo: Repo,
  wants: readonly string[],
  depth: number | undefined,
): { objects: Set<string>; commits: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      objects.add(want);
      const target = peelToCommit(repo, want);
      if (target !== null) queue.push({ oid: target, gen: 1 });
      continue;
    }
    if (object.type === 'commit') queue.push({ oid: want, gen: 1 });
  }
  const seenGen = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    const known = seenGen.get(oid);
    if (known !== undefined && known <= gen) continue;
    seenGen.set(oid, gen);
    if (depth !== undefined && gen > depth) continue;
    commits.add(oid);
    if (depth !== undefined && gen === depth) boundary.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const reachable of collectReachable([commit.tree], (id) => repo.objects.get(id), { allowMissing: true })) {
      objects.add(reachable);
    }
    objects.add(oid);
    if (depth === undefined || gen < depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return { objects, commits, boundary };
}

/**
 * The closure the client already holds: reachable from its haves, except a
 * declared shallow boundary contributes itself with its tree and blobs
 * while its parents are not walked.
 */
function ownedClosure(
  repo: Repo,
  haves: readonly string[],
  shallow: readonly string[],
): Set<string> {
  const boundary = new Set(shallow);
  const owned = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) {
    const commit = peelToCommit(repo, have);
    if (commit !== null) queue.push(commit);
    else if (repo.objects.has(have)) owned.add(have);
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    owned.add(oid);
    const commit = parseCommit(object.data);
    for (const reachable of collectReachable([commit.tree], (id) => repo.objects.get(id), { allowMissing: true })) {
      owned.add(reachable);
    }
    if (boundary.has(oid)) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return owned;
}

/** Plan one fetch: what to send, and the shallow-info lines. */
function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const want = wantClosure(repo, wants, depth);
  const owned = ownedClosure(repo, haves, shallow);
  const send = new Set<string>();
  for (const oid of want.objects) {
    if (!owned.has(oid)) send.add(oid);
  }
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const boundary of shallow) {
      const target = repo.objects.get(boundary);
      if (target === undefined || target.type !== 'commit') continue;
      const parents = parseCommit(target.data).parents;
      const parentKnown = parents.some((parent) => send.has(parent) || owned.has(parent));
      if (parentKnown) unshallow.push(boundary);
    }
  }
  return {
    send,
    shallow: depth === undefined ? [] : [...want.boundary].sort(),
    unshallow,
    wantCommits: [...want.commits],
  };
}

/** Build the pack bytes for a send set, in a stable order. */
function buildFetchPack(
  repo: Repo,
  send: ReadonlySet<string>,
): Buffer {
  const entries = [...send].sort().map((oid) => {
    const object = repo.objects.get(oid)!;
    return { type: object.type, data: object.data, oid };
  });
  return writePack(entries);
}

// ---------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------

/** Wrap `data` as sideband band-1 packets, chunked to the pkt-line limit. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_DATA = 65515;
  for (let offset = 0; offset < data.length; offset += MAX_DATA) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + MAX_DATA));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface UploadRequest {
  command: 'ls-refs' | 'fetch';
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function parseUploadRequest(packets: readonly Packet[]): UploadRequest {
  const lines = packetLines(packets);
  const first = lines[0] ?? '';
  const request: UploadRequest = {
    command: first.startsWith('command=fetch') ? 'fetch' : 'ls-refs',
    wants: [],
    haves: [],
    shallow: [],
    depth: undefined,
    done: false,
    prefixes: [],
    peel: false,
    symrefs: false,
    unborn: false,
  };
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line === 'done') request.done = true;
    else if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) request.depth = depth;
    } else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice(11).trim());
  }
  return request;
}

/** The v2 ls-refs answer. */
function lsRefsResponse(
  repo: Repo,
  request: UploadRequest,
): Buffer {
  const refs = repoRefLines(repo);
  const key = `ls-refs|${fingerprintFromLines(refs)}|peel=${request.peel}|symrefs=${request.symrefs}|unborn=${request.unborn}|${request.prefixes.join(',')}`;
  const hit = refResponseCacheGet(key);
  if (hit !== undefined) return hit;
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  // The HEAD pseudo-ref is only listed when the request asks for it: with
  // no prefixes, or with a prefix HEAD matches (clone sends `ref-prefix
  // HEAD` alongside refs/heads/ and refs/tags/ precisely to learn the
  // remote HEAD target). Without it, git cannot check the clone out.
  if (keep('HEAD')) {
    const mainTip = repo.refs.get('refs/heads/main');
    if (mainTip !== undefined) {
      parts.push(pkt(`${mainTip} HEAD${request.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (request.unborn) {
      parts.push(pkt(`unborn HEAD${request.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (request.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  refResponseCacheSet(key, body);
  return body;
}

/**
 * Assemble the pack section of a v2 fetch response (shallow-info + packfile
 * + sideband + flush). Pure function of (pack, shallow, unshallow), so the
 * result is cached in the fetch entry. The ACK prelude for a multi-round
 * fetch (hasHaves && !done) is NOT part of it: it is prepended by the
 * caller when present.
 */
function assembleFetchV2Response(pack: Buffer, shallow: string[], unshallow: string[]): Buffer {
  const parts: Buffer[] = [];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 fetch answer. */
function fetchV2Response(
  store: Store,
  repo: Repo,
  owner: string,
  name: string,
  request: UploadRequest,
): Buffer {
  const parts: Buffer[] = [];
  const hasHaves = request.haves.length > 0;
  if (hasHaves && !request.done) {
    const held = request.haves.filter((have) => {
      const commit = peelToCommit(repo, have);
      return commit !== null && repo.objects.has(commit);
    });
    parts.push(pkt('acknowledgments\n'));
    if (held.length === 0) {
      parts.push(pkt('NAK\n'));
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }
    for (const have of held) parts.push(pkt(`ACK ${have}\n`));
    const common = held.some((have) => {
      const haveCommit = peelToCommit(repo, have)!;
      return request.wants.some((want) => {
        const wantCommit = peelToCommit(repo, want);
        return wantCommit !== null && store.isAncestor(repo, haveCommit, wantCommit);
      });
    });
    if (!common) {
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }
    parts.push(pkt('ready\n'));
    parts.push(DELIM);
  }
  const cacheKey = [
    owner,
    name,
    request.wants.join(','),
    request.haves.join(','),
    request.shallow.join(','),
    request.depth ?? '',
    repo.objects.size,
  ].join('|');
  let cached = fetchCacheGet(cacheKey);
  if (cached === undefined) {
    const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
    const pack = buildFetchPack(repo, plan.send);
    cached = { pack, shallow: plan.shallow, unshallow: plan.unshallow, response: assembleFetchV2Response(pack, plan.shallow, plan.unshallow) };
    fetchCacheSet(cacheKey, cached);
  } else if (cached.response === undefined) {
    // Entry built by a v0 fetch with the same key (pack is protocol-free);
    // frame it for v2 once and keep it for later v2 requests.
    cached.response = assembleFetchV2Response(cached.pack, cached.shallow, cached.unshallow);
  }
  // No ACK prelude in `parts` (single-round fetch, or haves already done):
  // the cached assembly is the whole answer.
  if (parts.length === 0) return cached.response;
  // Multi-round fetch with an ACK prelude already in `parts`: prepend it.
  return Buffer.concat([Buffer.concat(parts), cached.response]);
}

/** The v0 fetch answer: shallow lines, ACK/NAK, sideband pack, flush. */
function fetchV0Response(
  store: Store,
  repo: Repo,
  owner: string,
  name: string,
  request: UploadRequest,
): Buffer {
  const cacheKey = [
    owner,
    name,
    request.wants.join(','),
    request.haves.join(','),
    request.shallow.join(','),
    request.depth ?? '',
    repo.objects.size,
  ].join('|');
  let cached = fetchCacheGet(cacheKey);
  if (cached === undefined) {
    const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
    cached = { pack: buildFetchPack(repo, plan.send), shallow: plan.shallow, unshallow: plan.unshallow };
    fetchCacheSet(cacheKey, cached);
  }
  const parts: Buffer[] = [];
  for (const oid of cached.shallow) parts.push(pkt(`shallow ${oid}`));
  for (const oid of cached.unshallow) parts.push(pkt(`unshallow ${oid}`));
  const held = request.haves.filter((have) => {
    const commit = peelToCommit(repo, have);
    return commit !== null && repo.objects.has(commit);
  });
  if (held.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    held.forEach((have, index) => {
      parts.push(pkt(index === held.length - 1 ? `ACK ${have}\n` : `ACK ${have} continue\n`));
    });
  }
  for (const packet of sidebandPackets(cached.pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v0 fetch body: wants section, then haves section. */
function parseV0Fetch(packets: readonly Packet[]): UploadRequest {
  const request: UploadRequest = {
    command: 'fetch',
    wants: [],
    haves: [],
    shallow: [],
    depth: undefined,
    done: false,
    prefixes: [],
    peel: false,
    symrefs: false,
    unborn: false,
  };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) request.depth = depth;
      }
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line === 'done') request.done = true;
    }
  }
  return request;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

/** Parse the command section of a receive-pack body. */
function parsePushCommands(packets: readonly Packet[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const caps = nul >= 0 ? text.slice(nul + 1) : '';
    const line = head.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) throw new ApiError(400, `bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      throw new ApiError(400, `bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref, caps });
  }
  if (commands.length === 0) throw new ApiError(400, 'receive-pack sent no commands');
  return commands;
}

/** Apply one push: parse the pack, store its objects, move the refs. */
function applyPush(
  store: Store,
  repo: Repo,
  commands: readonly PushCommand[],
  pack: Buffer,
  useSideband: boolean,
): Buffer {
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const result = applyRef(store, repo, command);
      reportLines.push(result === null ? `ok ${command.ref}` : `ng ${command.ref} ${result}`);
    }
  }
  const inner: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const line of reportLines) inner.push(pkt(`${line}\n`));
  inner.push(FLUSH);
  const innerBytes = Buffer.concat(inner);
  if (useSideband) {
    const outer: Buffer[] = [];
    for (const packet of sidebandPackets(innerBytes)) outer.push(packet);
    outer.push(FLUSH);
    return Buffer.concat(outer);
  }
  return Buffer.concat([...inner, FLUSH]);
}

/** Apply one ref update; returns null on success, the refusal reason otherwise. */
function applyRef(
  store: Store,
  repo: Repo,
  command: PushCommand,
): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return 'remote ref does not exist';
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'non-fast-forward';
    repo.refs.delete(command.ref);
    return null;
  }
  const newObject = repo.objects.get(command.newOid);
  if (newObject === undefined) return 'object not found';
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current === undefined) return 'remote ref does not exist';
  if (command.oldOid !== current) return 'non-fast-forward';
  if (command.newOid === command.oldOid) return null;
  const newCommit = peelToCommit(repo, command.newOid);
  if (newCommit === null) return 'non-fast-forward';
  if (!store.isAncestor(repo, command.oldOid, newCommit)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// ---------------------------------------------------------------------------
// the git routes
// ---------------------------------------------------------------------------

/** What a git handler answers: status, content type and body bytes. */
export interface GitAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function jsonError(status: number, message: string): GitAnswer {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/**
 * Handle one git smart-HTTP request. `subpath` is the path after
 * `/{owner}/{repo}.git/`, e.g. `info/refs` or `git-upload-pack`.
 * Throws ApiError for JSON error answers (404/400).
 */
export function handleGit(
  store: Store,
  owner: string,
  repoName: string,
  subpath: string,
  method: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitAnswer {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) throw new ApiError(404, `repository ${owner}/${repoName} not found`);

  if (method === 'GET' && subpath === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (headers['git-protocol'] ?? '') === 'version=2';
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: v2 ? advertisementV2() : advertisementV0('git-upload-pack', repo),
      };
    }
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        contentType: 'application/x-git-receive-pack-advertisement',
        body: advertisementV0('git-receive-pack', repo),
      };
    }
    throw new ApiError(400, `unknown git service ${JSON.stringify(service)}`);
  }

  if (method === 'POST' && subpath === 'git-upload-pack') {
    const { packets } = parsePktLines(body);
    const v2 = (headers['git-protocol'] ?? '') === 'version=2';
    if (v2) {
      const request = parseUploadRequest(packets);
      if (request.command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, request) };
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: fetchV2Response(store, repo, owner, repoName, request),
      };
    }
    const request = parseV0Fetch(packets);
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: fetchV0Response(store, repo, owner, repoName, request),
    };
  }

  if (method === 'POST' && subpath === 'git-receive-pack') {
    const { packets, consumed } = parsePktLines(body, { stopAtFlush: true });
    const commands = parsePushCommands(packets);
    const pack = body.subarray(consumed);
    const useSideband = (commands[0]?.caps ?? '').split(' ').includes('side-band-64k');
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: applyPush(store, repo, commands, pack, useSideband),
    };
  }

  throw new ApiError(404, 'Not Found');
}

/** A JSON error answer for git routes (kept beside handleGit for the router). */
export function gitJsonError(status: number, message: string): GitAnswer {
  return jsonError(status, message);
}
