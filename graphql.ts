// graphql.ts — a hand-written GraphQL executor for POST /api/graphql.
//
// The suite speaks a fixed set of documents (the gh CLI's queries, see the
// kit's checks-graphql.ts), so this executor covers exactly that surface:
// a tokenizer and recursive-descent parser, a small fixed schema for field
// validation and __type introspection, and resolvers over the shared store.
//
// Rules, all verified against the kit:
//   - POST only; no auth -> exactly 401 (the router enforces that, this
//     module only answers); a body that is an array of operations answers
//     an array of results in the same order (GitHub operation batching).
//   - Unknown fields are GraphQL errors, not HTTP errors: HTTP 200 with
//     an `errors` array whose message names the field, e.g.
//     `Cannot query field "noSuchFieldOnViewer" on type "Viewer".`
//   - Unknown repository -> data.repository = null, no errors.
//   - Relay ids are base64url of `Kind:owner/repo/...` (Store.relayId),
//     opaque and stable; never the plain databaseId or number.
//   - Issue state is OPEN/CLOSED, pull request state OPEN/CLOSED/MERGED,
//     pull request mergeable is MERGEABLE/CONFLICTING/UNKNOWN.
//   - issues(first, after, states, orderBy) pages by cursor; the cursor is
//     base64url of `issue:<seq>` of the last node on the page.
//   - Timestamps are the fixed scenario instant everywhere.

import { ApiError, Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import { base64UrlDecode, base64UrlEncode, FIXED_ISO } from './util.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (message: string): never => {
    throw new Error(`GraphQL syntax error at offset ${i}: ${message}`);
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) fail('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (esc !== undefined && esc in escapes) {
            out += escapes[esc]!;
            j += 2;
          } else {
            fail('bad string escape');
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) fail('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) fail('bad number');
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: 'name', value: match![0] });
      i += match![0].length;
      continue;
    }
    if (ch === ',') {
      i += 1;
      continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
}

type SelectionNode =
  | { kind: 'field'; alias?: string; name: string; args: ArgumentNode[]; selections?: SelectionNode[] }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selections: SelectionNode[] };

interface OperationNode {
  readonly operation: 'query' | 'mutation';
  readonly name?: string;
  readonly selections: SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: SelectionNode[];
}

interface Document {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`GraphQL syntax error: expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`GraphQL syntax error: expected name ${value ?? ''}, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private skipType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  parseDocument(): Document {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { operation, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          this.expectPunct('$');
          this.expectName();
          this.expectPunct(':');
          this.skipType();
          if (this.peek().kind === 'punct' && this.peek().value === '=') {
            this.next();
            this.parseValue();
          }
        }
        this.expectPunct(')');
      }
      return { operation, name, selections: this.parseSelectionSet() };
    }
    throw new Error(`GraphQL syntax error: expected an operation, got ${JSON.stringify(token.value)}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL syntax error: unexpected value ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// schema (fixed: field validation + __type introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Label: ['name', 'color', 'description'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'issue', 'issues',
    'pullRequest', 'pullRequests',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** A resolved GraphQL object carries its type name for nested selection. */
type GqlObject = { __typename: string; [key: string]: unknown };
type GqlValue = null | string | number | boolean | GqlObject | GqlValue[];

function valueFromAst(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueFromAst(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argsFromAst(args: readonly ArgumentNode[], variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = valueFromAst(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// object builders
// ---------------------------------------------------------------------------

function userObject(): GqlObject {
  return { __typename: 'User', login: VIEWER.login, id: Store.relayId('User', VIEWER.login), name: VIEWER.name, email: VIEWER.email };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function issueCursor(issue: Issue): string {
  return base64UrlEncode(`issue:${issue.seq}`);
}

function cursorSeq(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = base64UrlDecode(cursor);
    const match = /^issue:(\d+)$/.exec(decoded);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

interface Connection {
  __typename: string;
  nodes: GqlObject[];
  pageInfo: GqlObject;
  totalCount: number;
}

function connection(typeName: string, nodes: GqlObject[], hasNextPage: boolean, endCursor: string | null, totalCount: number): Connection {
  return {
    __typename: typeName,
    nodes,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: nodes.length > 0 ? issueCursorFor(nodes[0]!) : null,
      endCursor,
    },
    totalCount,
  };
}

function issueCursorFor(node: GqlObject): string | null {
  const issue = node['issue'] as Issue | undefined;
  return issue === undefined ? null : issueCursor(issue);
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecContext {
  readonly store: Store;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentNode>;
  readonly errors: Array<{ message: string }>;
}

function resolveSelections(
  typeName: string,
  value: GqlObject,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName && fragment.typeCondition !== value.__typename) continue;
      Object.assign(out, resolveSelections(fragment.typeCondition, value, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== value.__typename) continue;
      Object.assign(out, resolveSelections(selection.typeCondition ?? typeName, value, selection.selections, ctx));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const allowed = TYPE_FIELDS[typeName] ?? [];
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (!allowed.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args = argsFromAst(selection.args, ctx.variables);
    const raw = resolveField(typeName, selection.name, value, args, ctx);
    out[responseKey] = applySelections(raw, selection.selections, ctx);
  }
  return out;
}

/** Apply a field's sub-selections to its raw value (lists map element-wise). */
function applySelections(raw: GqlValue, selections: readonly SelectionNode[] | undefined, ctx: ExecContext): unknown {
  if (selections === undefined || selections.length === 0) return raw;
  if (raw === null) return null;
  if (Array.isArray(raw)) {
    return raw.map((item) =>
      item !== null && typeof item === 'object' && '__typename' in item
        ? resolveSelections((item as GqlObject).__typename, item as GqlObject, selections, ctx)
        : item,
    );
  }
  if (typeof raw === 'object' && '__typename' in raw) {
    return resolveSelections((raw as GqlObject).__typename, raw as GqlObject, selections, ctx);
  }
  return raw;
}

function resolveField(
  typeName: string,
  field: string,
  value: GqlObject,
  args: Readonly<Record<string, unknown>>,
  ctx: ExecContext,
): GqlValue {
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return userObject();
      if (field === 'repository') {
        const repo = store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
        return repo === undefined ? null : repoObject(repo);
      }
      if (field === 'node') {
        const id = String(args['id'] ?? '');
        const repo = store.repoFromRelayId(id);
        if (repo !== null) return repoObject(repo);
        const issue = store.issueFromRelayId(id);
        if (issue !== null) return issueObject(issue.repo, issue.issue);
        const pull = store.pullFromRelayId(id);
        if (pull !== null) return pullObject(pull.repo, pull.pull);
        return null;
      }
      if (field === '__type') {
        const name = String(args['name'] ?? '');
        if (!(name in TYPE_FIELDS) && name !== 'SearchType') return null;
        return { __typename: '__Type', typeName: name } as GqlObject;
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(field, args, ctx);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
    case 'Label': {
      return (value[field] as GqlValue) ?? null;
    }
    case 'User': {
      return (value[field] as string | null) ?? null;
    }
    case 'Repository': {
      const repo = value['repo'] as Repo;
      switch (field) {
        case 'id':
          return Store.relayId('Repository', VIEWER.login, repo.name);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${VIEWER.login}/${repo.name}`;
        case 'owner':
          return userObject();
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.defaultBranch };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'issue': {
          const number = Number(args['number']);
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues': {
          return issueConnection(store, repo, args);
        }
        case 'pullRequest': {
          const number = Number(args['number']);
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : pullObject(repo, pull);
        }
        case 'pullRequests': {
          const first = typeof args['first'] === 'number' ? args['first'] : 30;
          const allPulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
          const pulls = allPulls.slice(0, first);
          return connection(
            'PullRequestConnection',
            pulls.map((pull) => pullObject(repo, pull)),
            allPulls.length > pulls.length,
            null,
            allPulls.length,
          );
        }
        default:
          return null;
      }
    }
    case 'Ref': {
      return (value[field] as string | null) ?? null;
    }
    case 'Issue': {
      const repo = value['repo'] as Repo;
      const issue = value['issue'] as Issue;
      switch (field) {
        case 'id':
          return Store.relayId('Issue', VIEWER.login, repo.name, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'author':
          return userObject();
        case 'labels':
          return issue.labels.map((name) => ({ __typename: 'Label', name }));
        case 'comments':
          return {
            __typename: 'IssueConnection',
            nodes: issue.comments.map((comment) => ({
              __typename: 'IssueComment',
              repo,
              issue,
              comment,
              id: Store.relayId('IssueComment', VIEWER.login, repo.name, comment.id),
              body: comment.body,
              createdAt: FIXED_ISO,
              updatedAt: FIXED_ISO,
            })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: issue.comments.length,
          } as GqlObject;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = value['repo'] as Repo;
      const pull = value['pull'] as Pull;
      switch (field) {
        case 'id':
          return Store.relayId('PullRequest', VIEWER.login, repo.name, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.state === 'open' ? (store.isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return { __typename: 'Ref', name: pull.headRef };
        case 'baseRef':
          return { __typename: 'Ref', name: pull.baseRef };
        case 'files': {
          const first = typeof args['first'] === 'number' ? args['first'] : 10;
          const files = store.pullFiles(repo, pull).slice(0, first);
          return {
            __typename: 'PullRequestFileConnection',
            nodes: files.map((file) => ({
              __typename: 'PullRequestFile',
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status.toUpperCase(),
            })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: files.length,
          } as GqlObject;
        }
        case 'createdAt':
        case 'updatedAt':
          return FIXED_ISO;
        case 'author':
          return userObject();
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      return (value[field] as GqlValue) ?? null;
    }
    case 'PullRequestFile': {
      return (value[field] as GqlValue) ?? null;
    }
    case 'IssueComment': {
      const comment = value['comment'] as { id: number; body: string } | undefined;
      if (field === 'id') return (value['id'] as string | null) ?? null;
      if (field === 'body') return comment?.body ?? (value['body'] as string | null) ?? null;
      if (field === 'author') return userObject();
      if (field === 'createdAt' || field === 'updatedAt') return FIXED_ISO;
      return null;
    }
    case 'IssueCommentEdge':
    case 'IssueEdge':
    case 'PullRequestEdge': {
      return (value[field] as GqlValue) ?? null;
    }
    case 'PageInfo': {
      return (value[field] as string | boolean | null) ?? null;
    }
    case '__Type': {
      const name = value['typeName'] as string;
      if (field === 'name') return name;
      if (field === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        if (name === 'SearchType') return null;
        return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null }));
      }
      if (field === 'enumValues') {
        if (name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((enumName) => ({ __typename: '__EnumValue', name: enumName, description: null }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      return (value[field] as string | null) ?? null;
    }
    default:
      return null;
  }
}

/** The repository.issues connection: states filter, CREATED_AT order, cursor. */
function issueConnection(store: Store, repo: Repo, args: Readonly<Record<string, unknown>>): Connection {
  const states = Array.isArray(args['states']) ? (args['states'] as unknown[]).map(String) : null;
  const orderBy = (args['orderBy'] as { field?: string; direction?: string } | undefined) ?? {};
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  const first = typeof args['first'] === 'number' ? args['first'] : 30;
  const afterSeq = cursorSeq(args['after']);
  let issues = store.listIssues(repo, 'all', direction);
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  if (afterSeq !== null) {
    issues = direction === 'desc' ? issues.filter((issue) => issue.seq < afterSeq) : issues.filter((issue) => issue.seq > afterSeq);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]!) : null;
  return connection(
    'IssueConnection',
    page.map((issue) => issueObject(repo, issue)),
    hasNextPage,
    endCursor,
    issues.length,
  );
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function resolveMutation(field: string, args: Readonly<Record<string, unknown>>, ctx: ExecContext): GqlValue {
  const store = ctx.store;
  const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
  try {
    switch (field) {
      case 'createIssue': {
        const repo = store.repoFromRelayId(String(input['repositoryId'] ?? ''));
        if (repo === null) throw new ApiError(404, 'repository not found');
        const title = String(input['title'] ?? '');
        if (title === '') throw new ApiError(422, 'title is required');
        const issue = store.createIssue(repo, title, String(input['body'] ?? ''));
        return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) } as GqlObject;
      }
      case 'closeIssue': {
        const found = store.issueFromRelayId(String(input['issueId'] ?? ''));
        if (found === null) throw new ApiError(404, 'issue not found');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) } as GqlObject;
      }
      case 'createPullRequest': {
        const repo = store.repoFromRelayId(String(input['repositoryId'] ?? ''));
        if (repo === null) throw new ApiError(404, 'repository not found');
        const pull = store.createPull(
          repo,
          String(input['headRefName'] ?? ''),
          String(input['baseRefName'] ?? ''),
          String(input['title'] ?? ''),
          String(input['body'] ?? ''),
        );
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) } as GqlObject;
      }
      case 'mergePullRequest': {
        const found = store.pullFromRelayId(String(input['pullRequestId'] ?? ''));
        if (found === null) throw new ApiError(404, 'pull request not found');
        store.mergePull(found.repo, found.pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull) } as GqlObject;
      }
      case 'addComment': {
        const found = store.issueFromRelayId(String(input['subjectId'] ?? ''));
        if (found === null) throw new ApiError(404, 'issue not found');
        const comment = store.addComment(found.repo, found.issue, String(input['body'] ?? ''));
        const node: GqlObject = {
          __typename: 'IssueComment',
          repo: found.repo,
          issue: found.issue,
          comment,
          id: Store.relayId('IssueComment', VIEWER.login, found.repo.name, comment.id),
          body: comment.body,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
        };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null },
        } as GqlObject;
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// top-level handler
// ---------------------------------------------------------------------------

function runOperation(store: Store, request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { errors: [{ message: 'a GraphQL operation must be an object with a query string' }] };
  }
  const { query, variables } = request as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'a GraphQL operation must carry a query string' }] };
  }
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  const operation = document.operations[0];
  if (operation === undefined) {
    return { errors: [{ message: 'the document holds no operation' }] };
  }
  const ctx: ExecContext = {
    store,
    variables: (variables as Record<string, unknown> | undefined) ?? {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = resolveSelections(rootType, root, operation.selections, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/**
 * Handle POST /api/graphql. `body` is the already-parsed JSON body: one
 * operation object, or an array of them for GitHub operation batching.
 * Always answers HTTP 200 — GraphQL-level problems ride in `errors`.
 */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((item) => runOperation(store, item)) };
  }
  return { status: 200, body: runOperation(store, body) };
}
