// rest.ts — the GitHub REST surface under /api/v3.
//
// Routes (the suite's rest client only ever calls these):
//   GET  /                        root document (unauthenticated)
//   GET  /meta                    installed_version (unauthenticated)
//   GET  /user                    the viewer
//   GET  /user/repos              list the viewer's repos (paginated)
//   POST /user/repos              create a repo (201; 422 on a taken name)
//   GET  /repos/{owner}/{repo}    one repo
//   PATCH /repos/{owner}/{repo}   rename/description/private
//   DELETE /repos/{owner}/{repo}  delete (204)
//   GET  /repos/{owner}/{repo}/branches
//   GET  /repos/{owner}/{repo}/git/ref/heads/{branch}
//   POST /repos/{owner}/{repo}/git/refs            (create a branch/tag ref)
//   GET  /repos/{owner}/{repo}/commits[?sha=]
//   GET  /repos/{owner}/{repo}/contents[/{path}]
//   PUT  /repos/{owner}/{repo}/contents/{path}   (201 create / 200 update)
//   DELETE /repos/{owner}/{repo}/contents/{path}
//   GET  /repos/{owner}/{repo}/labels
//   POST /repos/{owner}/{repo}/labels            (201; existing name -> 200)
//   GET  /repos/{owner}/{repo}/issues            (state, sort, direction)
//   POST /repos/{owner}/{repo}/issues            (201; 422 unknown label)
//   GET  /repos/{owner}/{repo}/issues/{number}
//   PATCH /repos/{owner}/{repo}/issues/{number}  (state / title)
//   GET  /repos/{owner}/{repo}/issues/{number}/comments
//   POST /repos/{owner}/{repo}/issues/{number}/comments
//   GET  /repos/{owner}/{repo}/pulls             (state)
//   POST /repos/{owner}/{repo}/pulls             (201; 422 bad ref/duplicate)
//   GET  /repos/{owner}/{repo}/pulls/{number}
//   GET  /repos/{owner}/{repo}/pulls/{number}/files
//   GET  /repos/{owner}/{repo}/pulls/{number}/commits
//   PUT  /repos/{owner}/{repo}/pulls/{number}/merge
//
// Conventions, all verified against the kit's rest client and checks:
//   - every list honours per_page (default 30, capped at 100) and page,
//     and answers a `Link` header with absolute same-origin next/last
//     links whenever another page exists;
//   - errors are JSON `{message}` with the GitHub-ish status: 404 unknown
//     repo/issue/pull/ref/path, 422 duplicate repo / unknown label / bad
//     pull ref / stale contents sha, 409 stale contents sha, 405 merge of
//     a closed or conflicted pull;
//   - timestamps are the fixed scenario instant everywhere (the store is
//     deterministic, so nothing here can leak wall-clock time).

import { parseCommit, parseTree } from './gitobj.ts';
import { ApiError, Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import { FIXED_ISO } from './util.ts';
import { issueJsonCache } from './perf.ts';

/** What a REST handler answers: status, extra headers, JSON body. */
export interface RestAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** A pre-serialized JSON body: when present, `body` is unused. */
  readonly raw?: Buffer;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestAnswer {
  return { status, headers, body };
}

/** An answer whose JSON body is already serialized (issue-view cache). */
function okRaw(bytes: Buffer, status = 200, headers?: Record<string, string>): RestAnswer {
  return { status, headers, raw: bytes };
}

function notFound(what: string): ApiError {
  return new ApiError(404, `${what} not found`);
}

/**
 * The viewer's public user object. It is fully constant (fixed identity and
 * fixed timestamps), so one frozen object is shared by every view that
 * embeds it instead of rebuilding the same object per response — the write
 * workload builds one issue view per request, and the pull views embed it
 * three times each. The object is frozen and only ever stringified, never
 * mutated, so sharing it cannot change a response byte.
 */
const USER_VIEW: Record<string, unknown> = Object.freeze({
  login: VIEWER.login,
  id: VIEWER.id,
  avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
  type: 'User',
  site_admin: false,
  name: VIEWER.name,
  email: VIEWER.email,
  html_url: `https://github.com/${VIEWER.login}`,
  url: `/api/v3/users/${VIEWER.login}`,
  created_at: FIXED_ISO,
  updated_at: FIXED_ISO,
});

/** Parse `Name <email> 1234567890 +0000` into GitHub's author shape. */
function authorView(line: string): Record<string, unknown> {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: FIXED_ISO };
  const [, name, email, seconds] = match as [string, string, string, string, string];
  return { name, email, date: new Date(Number(seconds) * 1000).toISOString() };
}

function repoView(repo: Repo, baseUrl: string): Record<string, unknown> {
  const owner = VIEWER.login;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: USER_VIEW,
    private: repo.private,
    html_url: `${baseUrl}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    clone_url: `${baseUrl}/${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function issueView(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  const path = `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: USER_VIEW,
    assignee: null,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    url: `${path}/issues/${issue.number}`,
    html_url: `${baseUrl}/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    repository_url: path,
    comments_url: `${path}/issues/${issue.number}/comments`,
  };
}

function commentView(repo: Repo, comment: { id: number; body: string }, issueNumber: number, baseUrl: string): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: USER_VIEW,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    url: `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    html_url: `${baseUrl}/${VIEWER.login}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issueNumber}`,
  };
}

function pullView(store: Store, repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  const path = `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}`;
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !store.isConflicted(repo, pull) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${VIEWER.login}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: USER_VIEW },
    base: { label: `${VIEWER.login}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: USER_VIEW },
    user: USER_VIEW,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? FIXED_ISO) : null,
    url: `${path}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
  };
}

function commitView(store: Store, repo: Repo, sha: string, baseUrl: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') throw notFound('commit');
  const commit = parseCommit(object.data);
  return {
    sha,
    // GitHub's API presents the message without the trailing newline the
    // object stores (git log shows it the same way).
    commit: {
      message: commit.message.replace(/\n+$/, ''),
      author: authorView(commit.author),
      committer: authorView(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}/commits/${sha}`,
    html_url: `${baseUrl}/${VIEWER.login}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

/** Slice `items` to one page and build the Link header for the rest. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
): { page: T[]; link: string | null } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(Math.max(rawPerPage, 1), 100) : 30;
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const pageNumber = Number.isFinite(rawPage) ? Math.max(rawPage, 1) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const linkFor = (pageTarget: number, rel: string): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(pageTarget));
    return `<${baseUrl}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (pageNumber < totalPages) {
    links.push(linkFor(pageNumber + 1, 'next'));
    links.push(linkFor(totalPages, 'last'));
  }
  if (pageNumber > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(pageNumber - 1, 'prev'));
  }
  return { page, link: links.length > 0 ? links.join(', ') : null };
}

function pagedAnswer<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): RestAnswer {
  const { page, link } = paginate(items, query, baseUrl, path);
  return ok(page, 200, link === null ? undefined : { link });
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

function bodyObject(body: unknown, label: string): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new ApiError(400, `${label} expects a JSON object body`);
}

function stringField(body: Record<string, unknown>, field: string, fallback = ''): string {
  const value = body[field];
  return typeof value === 'string' ? value : fallback;
}

function repoOr404(store: Store, owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw notFound('repository');
  return repo;
}

function issueOr404(repo: Repo, numberText: string): Issue {
  const number = Number.parseInt(numberText, 10);
  const issue = repo.issues.get(number);
  if (issue === undefined) throw notFound('issue');
  return issue;
}

function pullOr404(repo: Repo, numberText: string): Pull {
  const number = Number.parseInt(numberText, 10);
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound('pull request');
  return pull;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

/** The file entries of a tree path, or null when the path is not a tree. */
function treeEntriesAt(store: Store, repo: Repo, treeOid: string, path: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> | null {
  const files = store.flattenTree(repo, treeOid);
  const prefix = path === '' ? '' : `${path}/`;
  const out: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> = [];
  const seenDirs = new Set<string>();
  for (const [filePath, entry] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const object = repo.objects.get(entry.oid);
      out.push({ name: rest, path: filePath, sha: entry.oid, type: 'file', size: object?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        const dirOid = dirTreeOid(repo, treeOid, `${prefix}${dir}`);
        out.push({ name: dir, path: `${prefix}${dir}`, sha: dirOid ?? '', type: 'dir', size: 0 });
      }
    }
  }
  return out;
}

/** The tree oid of a directory inside a tree, or null. */
function dirTreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  let current = treeOid;
  for (const part of dirPath.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === part && item.mode === '040000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function contentsGet(store: Store, repo: Repo, path: string, query: URLSearchParams, baseUrl: string): RestAnswer {
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = store.branchTip(repo, ref) ?? store.resolveCommit(repo, ref);
  if (tip === null) throw notFound('contents');
  const tree = parseCommit(repo.objects.get(tip)!.data).tree;
  const files = store.flattenTree(repo, tree);
  const file = files.get(path);
  if (path !== '' && file !== undefined) {
    const blob = repo.objects.get(file.oid);
    const content = blob?.data ?? Buffer.alloc(0);
    return ok({
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: path.split('/').pop(),
      path,
      content: content.toString('base64'),
      sha: file.oid,
      url: `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${path}`,
      html_url: `${baseUrl}/${VIEWER.login}/${repo.name}/blob/${ref}/${path}`,
      download_url: null,
    });
  }
  const entries = treeEntriesAt(store, repo, tree, path);
  if (entries === null) throw notFound('contents');
  // A path is a directory only when files live under it (or it is the
  // root). An empty tree does not make a missing path a directory: after
  // deleting a repo's only file, its path must 404, not list as [].
  const isDir = path === '' || [...files.keys()].some((key) => key.startsWith(`${path}/`));
  if (!isDir) throw notFound('contents');
  return ok(
    entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      size: entry.size,
      url: `${baseUrl}/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${entry.path}`,
      html_url: `${baseUrl}/${VIEWER.login}/${repo.name}/tree/${ref}/${entry.path}`,
      download_url: entry.type === 'file' ? null : undefined,
    })),
  );
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` are the path parts after `/api/v3/`
 * (so `[]` is the root); `path` is the full request path for Link headers;
 * `body` is the already-parsed JSON body (or undefined when there is none).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
  path: string,
): RestAnswer {
  // -- root and meta (unauthenticated) --------------------------------------
  if (segments.length === 0) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    return ok(
      {
        current_user_url: `${baseUrl}/api/v3/user`,
        current_user_authorizations_html_url: `${baseUrl}/settings/applications`,
        authorizations_url: `${baseUrl}/api/v3/authorizations`,
        code_search_url: `${baseUrl}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${baseUrl}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${baseUrl}/api/v3/user/emails`,
        emojis_url: `${baseUrl}/api/v3/emojis`,
        events_url: `${baseUrl}/api/v3/events`,
        feeds_url: `${baseUrl}/api/v3/feeds`,
        followers_url: `${baseUrl}/api/v3/users/{user}/followers`,
        following_url: `${baseUrl}/api/v3/users/{user}/following{/target}`,
        gists_url: `${baseUrl}/api/v3/gists{/gist_id}`,
        hub_url: `${baseUrl}/api/v3/hub`,
        issue_search_url: `${baseUrl}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${baseUrl}/api/v3/issues`,
        keys_url: `${baseUrl}/api/v3/user/keys`,
        labels_url: `${baseUrl}/api/v3/repos/{owner}/{repo}/labels{/name}`,
        marketplace_purchases_url: `${baseUrl}/api/v3/marketplace_listing/plans`,
        marketplace_listing_url: `${baseUrl}/api/v3/marketplace_listing`,
        notifications_url: `${baseUrl}/api/v3/notifications{?since,all,participating}`,
        organization_repositories_url: `${baseUrl}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_url: `${baseUrl}/api/v3/orgs/{org}`,
        public_gists_url: `${baseUrl}/api/v3/gists/public`,
        rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${baseUrl}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${baseUrl}/api/v3/user/repos{?type,page,per_page,sort}`,
        timeline_url: `${baseUrl}/api/v3/timeline`,
        user_url: `${baseUrl}/api/v3/users/{user}`,
        user_organizations_url: `${baseUrl}/api/v3/user/orgs`,
        user_repositories_url: `${baseUrl}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${baseUrl}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      },
      200,
      { 'x-oauth-scopes': 'repo, user' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    return ok({
      verifiable_password_authentication: true,
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: ['pre-receive', 'post-receive'],
      git: [],
      pages: [],
      imported: [],
      installed_version: '1.0.0',
      packages: [],
      actions: [],
      dependabot: [],
    });
  }

  // -- the viewer ------------------------------------------------------------
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    return ok(USER_VIEW);
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      return pagedAnswer(store.listRepos().map((repo) => repoView(repo, baseUrl)), query, baseUrl, path);
    }
    if (method === 'POST') {
      const payload = bodyObject(body, 'POST /user/repos');
      const name = stringField(payload, 'name');
      if (name === '') throw new ApiError(422, 'name is required');
      const created = store.createRepo(name, payload.private === true, stringField(payload, 'description'));
      if (created === null) throw new ApiError(422, `repository ${name} already exists`);
      return ok(repoView(created, baseUrl), 201);
    }
    throw new ApiError(404, 'Not Found');
  }

  // -- repos/{owner}/{repo}/... ----------------------------------------------
  if (segments[0] === 'repos' && segments.length >= 3) {
    const [_, owner, repoName, ...rest] = segments as [string, string, string, ...string[]];
    const repo = repoOr404(store, owner, repoName);

    if (rest.length === 0) {
      if (method === 'GET') return ok(repoView(repo, baseUrl));
      if (method === 'PATCH') {
        const payload = bodyObject(body, 'PATCH repo');
        const nextName = stringField(payload, 'name');
        if (nextName !== '' && nextName !== repo.name) {
          if (store.getRepo(owner, nextName) !== undefined) throw new ApiError(422, `repository ${nextName} already exists`);
          store.repos.delete(Store.repoKey(owner, repo.name));
          (repo as { name: string }).name = nextName;
          store.repos.set(Store.repoKey(owner, nextName), repo);
        }
        if (typeof payload.description === 'string') repo.description = payload.description;
        if (typeof payload.private === 'boolean') repo.private = payload.private;
        return ok(repoView(repo, baseUrl));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(ref)! },
          protected: false,
        }));
      return pagedAnswer(branches, query, baseUrl, path);
    }

    if (rest[0] === 'git' && rest[1] === 'ref' && rest.length >= 3 && method === 'GET') {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) throw notFound('reference');
      return ok({ ref: refName, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/refs/${refName}`, object: { sha, type: 'commit', url: '' } });
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      const payload = bodyObject(body, 'POST git/refs');
      const refName = stringField(payload, 'ref');
      const sha = stringField(payload, 'sha');
      if (!refName.startsWith('refs/heads/') && !refName.startsWith('refs/tags/')) {
        throw new ApiError(422, `ref ${refName} must start with refs/heads/ or refs/tags/`);
      }
      if (repo.refs.has(refName)) throw new ApiError(422, `reference ${refName} already exists`);
      const target = repo.objects.get(sha);
      if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
        throw new ApiError(422, `sha ${sha} is not a commit or tag in this repository`);
      }
      repo.refs.set(refName, sha);
      return ok(
        { ref: refName, url: `${baseUrl}/api/v3/repos/${owner}/${repoName}/git/refs/${refName}`, object: { sha, type: target.type, url: '' } },
        201,
      );
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const sha = query.get('sha');
      const tip = sha === null ? store.branchTip(repo, repo.defaultBranch) : store.resolveCommit(repo, sha);
      if (tip === null) throw notFound('commit');
      const commits = store.listCommits(repo, tip).map((oid) => commitView(store, repo, oid, baseUrl));
      return pagedAnswer(commits, query, baseUrl, path);
    }

    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') return contentsGet(store, repo, contentPath, query, baseUrl);
      if (method === 'PUT') {
        const payload = bodyObject(body, 'PUT contents');
        const message = stringField(payload, 'message', 'Update file');
        const encoded = stringField(payload, 'content');
        if (encoded === '') throw new ApiError(400, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(encoded, 'base64');
        } catch {
          throw new ApiError(400, 'content is not valid base64');
        }
        const branch = typeof payload.branch === 'string' ? payload.branch : undefined;
        const sha = typeof payload.sha === 'string' ? payload.sha : undefined;
        const result = store.writeContentsChecked(repo, contentPath, content, message, branch, sha);
        const blob = repo.objects.get(result.blobSha);
        return ok(
          {
            content: {
              name: contentPath.split('/').pop(),
              path: contentPath,
              sha: result.blobSha,
              size: blob?.data.length ?? 0,
              encoding: 'base64',
              content: encoded,
            },
            commit: { sha: result.commitSha, message },
          },
          result.created ? 201 : 200,
        );
      }
      if (method === 'DELETE') {
        const payload = bodyObject(body, 'DELETE contents');
        const message = stringField(payload, 'message', 'Delete file');
        const sha = typeof payload.sha === 'string' ? payload.sha : undefined;
        const result = store.deleteContents(repo, contentPath, message, sha);
        return ok({ commit: { sha: result.commitSha, message } });
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        const labels = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color ?? 'ededed' }));
        return pagedAnswer(labels, query, baseUrl, path);
      }
      if (rest.length === 1 && method === 'POST') {
        const payload = bodyObject(body, 'POST labels');
        const name = stringField(payload, 'name');
        if (name === '') throw new ApiError(422, 'name is required');
        const created = store.createLabel(repo, name, typeof payload.color === 'string' ? payload.color : undefined);
        return ok({ name: created.name, color: created.color ?? 'ededed' }, 201);
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
        const issues = store.listIssues(repo, state, direction).map((issue) => issueView(repo, issue, baseUrl));
        return pagedAnswer(issues, query, baseUrl, path);
      }
      if (rest.length === 1 && method === 'POST') {
        const payload = bodyObject(body, 'POST issues');
        const title = stringField(payload, 'title');
        if (title === '') throw new ApiError(422, 'title is required');
        const labels = Array.isArray(payload.labels) ? payload.labels.filter((item): item is string => typeof item === 'string') : [];
        const issue = store.createIssue(repo, title, stringField(payload, 'body'), labels);
        // The serialized view is cached, so the first GET of this issue is
        // already warm; the response bytes are the cached ones.
        return okRaw(issueJsonCache.get(repo, issue, baseUrl, () => issueView(repo, issue, baseUrl)), 201);
      }
      if (rest.length >= 2) {
        const issue = issueOr404(repo, rest[1]!);
        if (rest.length === 2 && method === 'GET') {
          return okRaw(issueJsonCache.get(repo, issue, baseUrl, () => issueView(repo, issue, baseUrl)));
        }
        if (rest.length === 2 && method === 'PATCH') {
          const payload = bodyObject(body, 'PATCH issue');
          if (typeof payload.title === 'string') issue.title = payload.title;
          if (typeof payload.body === 'string') issue.body = payload.body;
          if (payload.state === 'open' || payload.state === 'closed') issue.state = payload.state;
          if (Array.isArray(payload.labels)) {
            const labels = payload.labels.filter((item): item is string => typeof item === 'string');
            for (const name of labels) {
              if (!repo.labels.has(name)) throw new ApiError(422, `label ${name} does not exist`);
            }
            issue.labels = labels;
          }
          // The mutation changes the fingerprint, so the cache rebuilds.
          return okRaw(issueJsonCache.get(repo, issue, baseUrl, () => issueView(repo, issue, baseUrl)));
        }
        if (rest[2] === 'comments') {
          if (rest.length === 3 && method === 'GET') {
            const comments = issue.comments.map((comment) => commentView(repo, comment, issue.number, baseUrl));
            return pagedAnswer(comments, query, baseUrl, path);
          }
          if (rest.length === 3 && method === 'POST') {
            const payload = bodyObject(body, 'POST comments');
            const commentBody = stringField(payload, 'body');
            if (commentBody === '') throw new ApiError(422, 'body is required');
            const comment = store.addComment(repo, issue, commentBody);
            return ok(commentView(repo, comment, issue.number, baseUrl), 201);
          }
        }
        throw new ApiError(404, 'Not Found');
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const pulls = [...repo.pulls.values()]
          .filter((pull) => (state === 'all' ? true : state === 'closed' ? pull.state === 'closed' : pull.state === 'open'))
          .sort((a, b) => a.seq - b.seq)
          .map((pull) => pullView(store, repo, pull, baseUrl));
        return pagedAnswer(pulls, query, baseUrl, path);
      }
      if (rest.length === 1 && method === 'POST') {
        const payload = bodyObject(body, 'POST pulls');
        const head = stringField(payload, 'head');
        const base = stringField(payload, 'base');
        const title = stringField(payload, 'title');
        if (head === '' || base === '' || title === '') throw new ApiError(422, 'head, base and title are required');
        const pull = store.createPull(repo, head, base, title, stringField(payload, 'body'));
        return ok(pullView(store, repo, pull, baseUrl), 201);
      }
      if (rest.length >= 2) {
        const pull = pullOr404(repo, rest[1]!);
        if (rest.length === 2 && method === 'GET') return ok(pullView(store, repo, pull, baseUrl));
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          return ok(store.pullFiles(repo, pull));
        }
        if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
          const commits = store.listCommits(repo, pull.headSha).map((oid) => commitView(store, repo, oid, baseUrl));
          return pagedAnswer(commits, query, baseUrl, path);
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const mergeSha = store.mergePull(repo, pull);
          return ok({ merged: true, sha: mergeSha, message: `Pull Request #${pull.number} merged` });
        }
        throw new ApiError(404, 'Not Found');
      }
      throw new ApiError(404, 'Not Found');
    }
  }

  throw new ApiError(404, 'Not Found');
}
