// store.ts — the forge's in-memory store: repositories, git objects, refs,
// issues, labels, pull requests and comments.
//
// One process serves one trial, so nothing persists: a fresh Store is built
// on every boot. All stored data is deterministic — commit identities carry a
// counter-based timestamp, issue and pull-request dates are fixed — so two
// runs over the same requests produce the same bytes.

import {
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { base64UrlDecode, base64UrlEncode, FIXED_ISO, fixedIso, SCENARIO_EPOCH_SEC } from './util.ts';

/** An error that becomes an HTTP status with a JSON {message} body. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The viewer: the login the trial's bearer token names, always this one. */
export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** One issue comment. */
export interface IssueComment {
  readonly id: number;
  readonly body: string;
}

/** One issue. `seq` is the creation order, used for created sorting. */
export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: IssueComment[];
  readonly seq: number;
}

/** One pull request. `baseFiles` is the base tree at creation, for conflicts. */
export interface Pull {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly baseFiles: Map<string, string>;
  readonly seq: number;
}

/** One repository: its metadata, git store, refs, issues and pull requests. */
export interface Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly seq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color?: string }>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  issueSeq: number;
  pullSeq: number;
}

/** A flattened tree: path -> blob/tree oid. */
export type FileMap = Map<string, { oid: string; mode: string }>;

/** One changed file of a pull request, in GitHub's files shape. */
export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/**
 * The whole store. Counters start at 1 and only grow, so ids are stable
 * across reads and unique across repositories.
 */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private commitCounter = 0;

  // ------------------------------------------------------------------ repos

  /** The key a repository lives under: its owner and name. */
  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The repository at `owner/name`, or undefined. Only the viewer owns repos. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(Store.repoKey(owner, name));
  }

  /** Every repository, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Create a repository under the viewer; null when the name is taken. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = Store.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: id,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      issueSeq: 1,
      pullSeq: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** Delete a repository; true when it existed. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(Store.repoKey(owner, name));
  }

  // -------------------------------------------------------------- Relay ids

  /** An opaque, stable global id: base64url of `Kind:part/part/...`. */
  static relayId(kind: string, ...parts: readonly (string | number)[]): string {
    return base64UrlEncode(`${kind}:${parts.join('/')}`);
  }

  /** Decode a Relay id back to its kind and parts; null when malformed. */
  static decodeRelayId(id: string): { kind: string; parts: string[] } | null {
    const text = base64UrlDecode(id);
    if (text === null) return null;
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split('/') };
  }

  static repoRelayId(owner: string, name: string): string {
    return Store.relayId('Repository', owner, name);
  }

  static issueRelayId(owner: string, repo: string, number: number): string {
    return Store.relayId('Issue', owner, repo, number);
  }

  static pullRelayId(owner: string, repo: string, number: number): string {
    return Store.relayId('PullRequest', owner, repo, number);
  }

  static commentRelayId(owner: string, repo: string, id: number): string {
    return Store.relayId('IssueComment', owner, repo, id);
  }

  /** The repository a Relay id names, or null. */
  repoFromRelayId(id: string): Repo | null {
    const decoded = Store.decodeRelayId(id);
    if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length !== 2) return null;
    return this.getRepo(decoded.parts[0]!, decoded.parts[1]!) ?? null;
  }

  /** The issue a Relay id names, or null. */
  issueFromRelayId(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = Store.decodeRelayId(id);
    if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length !== 3) return null;
    const repo = this.getRepo(decoded.parts[0]!, decoded.parts[1]!);
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number(decoded.parts[2]));
    return issue === undefined ? null : { repo, issue };
  }

  /** The pull request a Relay id names, or null. */
  pullFromRelayId(id: string): { repo: Repo; pull: Pull } | null {
    const decoded = Store.decodeRelayId(id);
    if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length !== 3) return null;
    const repo = this.getRepo(decoded.parts[0]!, decoded.parts[1]!);
    if (repo === undefined) return null;
    const pull = repo.pulls.get(Number(decoded.parts[2]));
    return pull === undefined ? null : { repo, pull };
  }

  // ------------------------------------------------------------ git objects

  /** Store an object, returning its oid (a no-op when it is already there). */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The object an oid names in this repo, or undefined. */
  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string): GitObject | undefined => repo.objects.get(oid);
  }

  /** The commit a ref or oid resolves to, or null. Tags peel to their commit. */
  resolveCommit(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (isObjectId(ref)) {
      oid = ref;
    } else {
      const name = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      oid = repo.refs.get(name);
    }
    if (oid === undefined) return null;
    const object = repo.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      const target = repo.objects.get(tag.object);
      return target !== undefined && target.type === 'commit' ? tag.object : null;
    }
    return object.type === 'commit' ? oid : null;
  }

  /** The tip commit oid a branch name points at, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    const object = repo.objects.get(oid);
    return object !== undefined && object.type === 'commit' ? oid : null;
  }

  /** Flatten a tree object into path -> {oid, mode}, recursively. */
  flattenTree(repo: Repo, treeOid: string): FileMap {
    const out: FileMap = new Map();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the tree for a flat file map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: FileMap): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The deterministic author/committer line for a server-made commit. */
  private identityLine(): string {
    this.commitCounter += 1;
    return `${VIEWER.name} <${VIEWER.email}> ${SCENARIO_EPOCH_SEC + this.commitCounter} +0000`;
  }

  /** Create a commit object on `treeOid` with `parents`; returns its oid. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const who = this.identityLine();
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({ tree: treeOid, parents, message: text, author: who, committer: who });
    return this.putObject(repo, 'commit', data);
  }

  /** Create an annotated tag object; returns its oid. */
  makeTag(repo: Repo, target: string, name: string, message: string): string {
    const who = this.identityLine();
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildTag({ object: target, type: 'commit', tag: name, message: text, tagger: who });
    return this.putObject(repo, 'tag', data);
  }

  /** Commits reachable from `tip`, newest first (depth-first, parents after). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const commit = parseCommit(object.data);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** Every object id reachable from `tips`, minus those reachable from `haveTips`. */
  closureMinus(repo: Repo, tips: readonly string[], haveTips: readonly string[]): Set<string> {
    const wanted = collectReachable(tips, this.lookup(repo));
    const have = collectReachable(haveTips, this.lookup(repo), { allowMissing: true });
    for (const oid of have) wanted.delete(oid);
    return wanted;
  }

  // -------------------------------------------------------------- contents

  /**
   * Write a file through the contents API. Returns the commit and blob shas
   * and whether it was a create. Throws ApiError 409 on a stale sha, 422
   * when creating over an existing file or updating a missing one.
   */
  writeContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch?: string,
  ): { commitSha: string; blobSha: string; created: boolean; sha?: string } {
    return this.writeContentsChecked(repo, path, content, message, branch, undefined);
  }

  writeContentsChecked(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const targetBranch = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${targetBranch}`;
    const tip = this.branchTip(repo, targetBranch);
    let parents: string[] = [];
    let files: FileMap = new Map();
    if (tip !== null) {
      parents = [tip];
      files = this.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
    } else {
      const defaultTip = this.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== null && targetBranch !== repo.defaultBranch) {
        parents = [defaultTip];
        files = this.flattenTree(repo, parseCommit(repo.objects.get(defaultTip)!.data).tree);
      }
    }
    const existing = files.get(path);
    if (sha !== undefined) {
      if (existing === undefined) throw new ApiError(422, `no file at ${path} to update`);
      if (sha !== existing.oid) throw new ApiError(409, `sha ${sha} is stale for ${path}`);
    } else if (existing !== undefined) {
      throw new ApiError(422, `${path} already exists`);
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const next = new Map(files);
    next.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTreeFromMap(repo, next);
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha, created: existing === undefined };
  }

  /** Delete a file through the contents API; throws ApiError 404/409. */
  deleteContents(repo: Repo, path: string, message: string, sha: string | undefined): { commitSha: string } {
    const tip = this.branchTip(repo, repo.defaultBranch);
    if (tip === null) throw new ApiError(404, `no file at ${path}`);
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const files = this.flattenTree(repo, tree);
    const existing = files.get(path);
    if (existing === undefined) throw new ApiError(404, `no file at ${path}`);
    if (sha !== undefined && sha !== existing.oid) throw new ApiError(409, `sha ${sha} is stale for ${path}`);
    const next = new Map(files);
    next.delete(path);
    const treeOid = this.buildTreeFromMap(repo, next);
    const commitSha = this.makeCommit(repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitSha);
    return { commitSha };
  }

  // ----------------------------------------------------------- issues/labels

  /** Create a label; returns the existing one when the name is taken. */
  createLabel(repo: Repo, name: string, color?: string): { name: string; color?: string } {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label = { name, ...(color !== undefined ? { color } : {}) };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; throws ApiError 422 when a label does not exist. */
  createIssue(repo: Repo, title: string, body: string, labels: readonly string[] = []): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ApiError(422, `label ${name} does not exist`);
    }
    const number = repo.issueSeq;
    repo.issueSeq += 1;
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    const issue: Issue = {
      id,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: id,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  /** List issues, filtered by state and ordered by creation (seq). */
  listIssues(repo: Repo, state: string, direction: 'asc' | 'desc'): Issue[] {
    const all = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
    const filtered =
      state === 'all' ? all : state === 'closed' ? all.filter((issue) => issue.state === 'closed') : all.filter((issue) => issue.state === 'open');
    return direction === 'desc' ? filtered.reverse() : filtered;
  }

  /** Add a comment to an issue; returns the comment. */
  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    const comment: IssueComment = { id, body };
    issue.comments.push(comment);
    return comment;
  }

  // --------------------------------------------------------- pull requests

  /** Create a pull request; throws ApiError 422 on a bad ref or a duplicate. */
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null) throw new ApiError(422, `head branch ${head} does not exist`);
    if (baseSha === null) throw new ApiError(422, `base branch ${base} does not exist`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        throw new ApiError(422, `an open pull request already exists for ${head} into ${base}`);
      }
    }
    const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const snapshot = new Map<string, string>();
    for (const [path, entry] of baseFiles) snapshot.set(path, entry.oid);
    const number = repo.pullSeq;
    repo.pullSeq += 1;
    const id = this.nextPullId;
    this.nextPullId += 1;
    const pull: Pull = {
      number,
      id,
      title,
      body,
      state: 'open',
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      baseFiles: snapshot,
      seq: id,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The head tree's files, flattened. */
  private headFiles(repo: Repo, pull: Pull): FileMap {
    const headTip = this.branchTip(repo, pull.headRef);
    if (headTip === null) return new Map();
    return this.flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  }

  /** The current base tree's files, flattened. */
  private currentBaseFiles(repo: Repo, pull: Pull): FileMap {
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return new Map();
    return this.flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  }

  /** The pull request's changed files, base snapshot vs head tree. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const head = this.headFiles(repo, pull);
    const out: PullFile[] = [];
    const paths = new Set([...pull.baseFiles.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = pull.baseFiles.get(path);
      const headEntry = head.get(path);
      if (baseOid === undefined && headEntry !== undefined) {
        const lines = countLines(repo, headEntry.oid);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (baseOid !== undefined && headEntry === undefined) {
        const lines = countLines(repo, baseOid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (baseOid !== undefined && headEntry !== undefined && baseOid !== headEntry.oid) {
        const [additions, deletions] = diffLines(repo, baseOid, headEntry.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** True when the pull request conflicts with the current base. */
  isConflicted(repo: Repo, pull: Pull): boolean {
    const head = this.headFiles(repo, pull);
    const current = this.currentBaseFiles(repo, pull);
    const paths = new Set([...pull.baseFiles.keys(), ...head.keys()]);
    for (const path of paths) {
      const snap = pull.baseFiles.get(path) ?? null;
      const headOid = head.get(path)?.oid ?? null;
      if (snap === headOid) continue;
      const cur = current.get(path)?.oid ?? null;
      if (cur !== snap && cur !== headOid) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch. Throws ApiError 404
   * (unknown), 405 (already merged or conflicted). Returns the merge sha.
   */
  mergePull(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') throw new ApiError(405, `pull request #${pull.number} is already ${pull.state}`);
    if (this.isConflicted(repo, pull)) throw new ApiError(405, `pull request #${pull.number} has a merge conflict`);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) throw new ApiError(422, `base branch ${pull.baseRef} does not exist`);
    const headTip = this.branchTip(repo, pull.headRef);
    if (headTip === null) throw new ApiError(422, `head branch ${pull.headRef} does not exist`);
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const message = `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.headRef}`;
    const mergeSha = this.makeCommit(repo, headTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = fixedIso(this.commitCounter);
    return mergeSha;
  }
}

/** How many lines a blob holds (a trailing newline does not add a line). */
function countLines(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (object === undefined) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Added/removed line counts between two blobs, by multiset line diff. */
function diffLines(repo: Repo, oldOid: string, newOid: string): [number, number] {
  const oldObject = repo.objects.get(oldOid);
  const newObject = repo.objects.get(newOid);
  const oldLines = oldObject === undefined ? [] : splitLines(oldObject.data.toString('utf8'));
  const newLines = newObject === undefined ? [] : splitLines(newObject.data.toString('utf8'));
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return [additions, deletions];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
