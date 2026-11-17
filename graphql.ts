// GitHub GraphQL v4 for the documents gh and github-mcp-server send: a small
// tokenizer + recursive-descent parser and an executor over the shared store.
// Unknown fields are HTTP 200 with an `errors` array naming the field; an
// unknown repository is `data.repository = null` with no errors.

import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  diffTrees,
  getObject,
  parseCommit,
  resolveRef,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { pullMergeable, squashMergePull } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface Token {
  kind: 'punct' | 'name' | 'string' | 'number';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():[]!$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    // Variable definitions: ($x: Type, ...) — types are parsed and ignored.
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') depth -= 1;
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      // Named fragment spread (not used by the suite): skip its selection set if present.
      if (next !== undefined && next.kind === 'name') this.next();
      return { kind: 'fragment', typeCondition: '', selections: [] };
    }
    const nameOrAlias = this.expectName();
    let alias: string | null = null;
    let name = nameOrAlias;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value} in GraphQL value`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema (for __type introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'assignees', 'milestone', 'locked', 'viewerCanUpdate'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'closedAt', 'draft', 'additions', 'deletions'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', 'fork', 'stargazerCount', 'watchers', 'isPrivate', 'defaultBranch'],
  },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
};

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

interface GqlObj {
  __type: string;
  data: unknown;
}

function obj(type: string, data: unknown): GqlObj {
  return { __type: type, data };
}

function isObj(value: unknown): value is GqlObj {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

interface Executor {
  store: Store;
}

type Resolver = (data: unknown, args: Record<string, unknown>, exec: Executor) => unknown;

function userObj(login: string): GqlObj {
  return obj('User', { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, name: login === VIEWER_LOGIN ? VIEWER_NAME : login, email: login === VIEWER_LOGIN ? VIEWER_EMAIL : '' });
}

function repoObj(repo: Repo): GqlObj {
  return obj('Repository', repo);
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: Repo, pull: Pull): GqlObj {
  return obj('PullRequest', { repo, pull });
}

function encodeCursor(kind: string, value: number | string): string {
  return Buffer.from(`${kind}:${value}`).toString('base64');
}

function decodeCursor(cursor: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states as string[]);
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT') {
    list.sort((a, b) => (orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  } else {
    list.sort((a, b) => a.createdSeq - b.createdSeq);
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = decodeCursor(args.after);
    if (decoded !== null && decoded.kind === 'issue') {
      const index = list.findIndex((issue) => issue.number === Number(decoded.value));
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor('issue', page[page.length - 1]!.number) : null;
  return obj('IssueConnection', {
    nodes: page.map((issue) => issueObj(repo, issue)),
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, startCursor: page.length > 0 ? encodeCursor('issue', page[0]!.number) : null, endCursor },
    totalCount: list.length,
  });
}

function pullRequestConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  const list = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq);
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = decodeCursor(args.after);
    if (decoded !== null && decoded.kind === 'pull') {
      const index = list.findIndex((pull) => pull.number === Number(decoded.value));
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor('pull', page[page.length - 1]!.number) : null;
  return obj('PullRequestConnection', {
    nodes: page.map((pull) => pullObj(repo, pull)),
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, startCursor: page.length > 0 ? encodeCursor('pull', page[0]!.number) : null, endCursor },
    totalCount: list.length,
  });
}

function pullRequestFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObj {
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  let paths: string[] = [];
  if (headTip !== undefined && baseTip !== undefined) {
    const headTree = parseCommit(getObject(repo, headTip)!.data).tree;
    const baseTree = parseCommit(getObject(repo, baseTip)!.data).tree;
    paths = diffTrees(repo, baseTree, headTree)
      .filter((change) => change.status !== 'removed')
      .map((change) => change.path);
  }
  const first = typeof args.first === 'number' ? args.first : paths.length;
  const page = paths.slice(0, first);
  return obj('PullRequestFileConnection', {
    nodes: page.map((path) => obj('PullRequestFile', { path })),
    pageInfo: { hasNextPage: page.length < paths.length, hasPreviousPage: false, startCursor: null, endCursor: page.length > 0 ? encodeCursor('file', page[page.length - 1]!) : null },
    totalCount: paths.length,
  });
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(VIEWER_LOGIN),
    repository: (_data, args, exec) => {
      const repo = exec.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_data, args, exec) => {
      const resolved = exec.store.resolveGlobalId(String(args.id ?? ''));
      if (resolved === null) return null;
      if (resolved.kind === 'repo') return repoObj(resolved.repo);
      if (resolved.kind === 'issue') return issueObj(resolved.repo, resolved.issue!);
      if (resolved.kind === 'pull') return pullObj(resolved.repo, resolved.pull!);
      return null;
    },
    __type: (_data, args) => {
      const info = TYPE_INFO[String(args.name ?? '')];
      if (info === undefined) return null;
      return obj('__Type', { name: String(args.name), kind: info.kind, fields: info.fields, enumValues: info.enumValues ?? [] });
    },
  },
  Mutation: {
    createIssue: (_data, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = exec.store.resolveGlobalId(String(input.repositoryId ?? ''));
      if (resolved === null || resolved.kind !== 'repo') return obj('CreateIssuePayload', { issue: null });
      const issue = exec.store.createIssue(resolved.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return obj('CreateIssuePayload', { issue: issueObj(resolved.repo, issue) });
    },
    closeIssue: (_data, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = exec.store.resolveGlobalId(String(input.issueId ?? ''));
      if (resolved === null || resolved.kind !== 'issue') return obj('CloseIssuePayload', { issue: null });
      resolved.issue!.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObj(resolved.repo, resolved.issue!) });
    },
    createPullRequest: (_data, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = exec.store.resolveGlobalId(String(input.repositoryId ?? ''));
      if (resolved === null || resolved.kind !== 'repo') return obj('CreatePullRequestPayload', { pullRequest: null });
      const repo = resolved.repo;
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) return obj('CreatePullRequestPayload', { pullRequest: null });
      const pull = exec.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull) });
    },
    mergePullRequest: (_data, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = exec.store.resolveGlobalId(String(input.pullRequestId ?? ''));
      if (resolved === null || resolved.kind !== 'pull') return obj('MergePullRequestPayload', { pullRequest: null });
      squashMergePull(resolved.repo, resolved.pull!);
      return obj('MergePullRequestPayload', { pullRequest: pullObj(resolved.repo, resolved.pull!) });
    },
    addComment: (_data, args, exec) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const resolved = exec.store.resolveGlobalId(String(input.subjectId ?? ''));
      if (resolved === null || resolved.kind !== 'issue') return obj('AddCommentPayload', { commentEdge: null });
      const comment = exec.store.addComment(resolved.repo, resolved.issue!.number, String(input.body ?? ''));
      return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node: obj('Comment', { repo: resolved.repo, comment }) }) });
    },
  },
  Repository: {
    id: (data) => (data as Repo).gid,
    databaseId: (data) => (data as Repo).dbId,
    name: (data) => (data as Repo).name,
    nameWithOwner: (data) => `${(data as Repo).owner}/${(data as Repo).name}`,
    owner: (data) => userObj((data as Repo).owner),
    defaultBranchRef: (data) => obj('Ref', { name: (data as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (data) => (data as Repo).description,
    private: (data) => (data as Repo).isPrivate,
    isPrivate: (data) => (data as Repo).isPrivate,
    url: (data) => `https://github.com/${(data as Repo).owner}/${(data as Repo).name}`,
    createdAt: () => FIXED_ISO,
    updatedAt: () => FIXED_ISO,
    issue: (data, args) => {
      const repo = data as Repo;
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (data, args) => issueConnection(data as Repo, args),
    pullRequests: (data, args) => pullRequestConnection(data as Repo, args),
    pullRequest: (data, args) => {
      const repo = data as Repo;
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    },
  },
  Issue: {
    id: (data) => (data as { issue: Issue }).issue.gid,
    number: (data) => (data as { issue: Issue }).issue.number,
    title: (data) => (data as { issue: Issue }).issue.title,
    body: (data) => (data as { issue: Issue }).issue.body,
    state: (data) => ((data as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (data) => {
      const { repo, issue } = data as { repo: Repo; issue: Issue };
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: () => FIXED_ISO,
    updatedAt: () => FIXED_ISO,
    closedAt: (data) => ((data as { issue: Issue }).issue.state === 'closed' ? FIXED_ISO : null),
    author: () => userObj(VIEWER_LOGIN),
    repository: (data) => repoObj((data as { repo: Repo }).repo),
  },
  PullRequest: {
    id: (data) => (data as { pull: Pull }).pull.gid,
    number: (data) => (data as { pull: Pull }).pull.number,
    title: (data) => (data as { pull: Pull }).pull.title,
    body: (data) => (data as { pull: Pull }).pull.body,
    state: (data) => ((data as { pull: Pull }).pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    headRefName: (data) => (data as { pull: Pull }).pull.headRef,
    baseRefName: (data) => (data as { pull: Pull }).pull.baseRef,
    mergeable: (data) => {
      const { repo, pull } = data as { repo: Repo; pull: Pull };
      return pullMergeable(repo, pull);
    },
    merged: (data) => (data as { pull: Pull }).pull.merged,
    mergedAt: (data) => (data as { pull: Pull }).pull.mergedAt,
    files: (data, args) => {
      const { repo, pull } = data as { repo: Repo; pull: Pull };
      return pullRequestFiles(repo, pull, args);
    },
    headRef: (data) => obj('Ref', { name: (data as { pull: Pull }).pull.headRef }),
    baseRef: (data) => obj('Ref', { name: (data as { pull: Pull }).pull.baseRef }),
    url: (data) => {
      const { repo, pull } = data as { repo: Repo; pull: Pull };
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    createdAt: () => FIXED_ISO,
    updatedAt: () => FIXED_ISO,
  },
  User: {
    id: (data) => String((data as { id: number }).id),
    login: (data) => (data as { login: string }).login,
    name: (data) => (data as { name: string }).name,
    email: (data) => (data as { email: string }).email,
    url: (data) => `https://github.com/${(data as { login: string }).login}`,
  },
  Ref: {
    name: (data) => (data as { name: string }).name,
  },
  IssueConnection: {
    nodes: (data) => (data as { nodes: unknown[] }).nodes,
    pageInfo: (data) => obj('PageInfo', (data as { pageInfo: unknown }).pageInfo),
    totalCount: (data) => (data as { totalCount: number }).totalCount,
  },
  PullRequestConnection: {
    nodes: (data) => (data as { nodes: unknown[] }).nodes,
    pageInfo: (data) => obj('PageInfo', (data as { pageInfo: unknown }).pageInfo),
    totalCount: (data) => (data as { totalCount: number }).totalCount,
  },
  PullRequestFileConnection: {
    nodes: (data) => (data as { nodes: unknown[] }).nodes,
    pageInfo: (data) => obj('PageInfo', (data as { pageInfo: unknown }).pageInfo),
    totalCount: (data) => (data as { totalCount: number }).totalCount,
  },
  PullRequestFile: {
    path: (data) => (data as { path: string }).path,
  },
  PageInfo: {
    hasNextPage: (data) => (data as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (data) => (data as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (data) => (data as { startCursor: string | null }).startCursor,
    endCursor: (data) => (data as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (data) => (data as { issue: GqlObj | null }).issue,
  },
  CloseIssuePayload: {
    issue: (data) => (data as { issue: GqlObj | null }).issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (data) => (data as { pullRequest: GqlObj | null }).pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (data) => (data as { pullRequest: GqlObj | null }).pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (data) => (data as { commentEdge: GqlObj | null }).commentEdge,
  },
  CommentEdge: {
    node: (data) => (data as { node: GqlObj }).node,
  },
  Comment: {
    id: (data) => (data as { comment: { gid: string } }).comment.gid,
    body: (data) => (data as { comment: { body: string } }).comment.body,
  },
  __Type: {
    name: (data) => (data as { name: string }).name,
    kind: (data) => (data as { kind: string }).kind,
    fields: (data) => ((data as { fields: string[] }).fields ?? []).map((name) => obj('__Field', { name })),
    enumValues: (data) => ((data as { enumValues: string[] }).enumValues ?? []).map((name) => obj('__EnumValue', { name })),
  },
  __Field: {
    name: (data) => (data as { name: string }).name,
  },
  __EnumValue: {
    name: (data) => (data as { name: string }).name,
  },
};

function resolveSelections(type: string, data: unknown, selections: SelectionNode[], variables: Record<string, unknown>, errors: Array<{ message: string }>, exec: Executor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === '' || selection.typeCondition === type) {
        Object.assign(out, resolveSelections(type, data, selection.selections, variables, errors, exec));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(type, data, selection, variables, errors, exec);
  }
  return out;
}

function resolveField(type: string, data: unknown, field: FieldNode, variables: Record<string, unknown>, errors: Array<{ message: string }>, exec: Executor): unknown {
  const table = RESOLVERS[type];
  const resolver = table === undefined ? undefined : table[field.name];
  if (resolver === undefined) {
    errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  let result: unknown;
  try {
    result = resolver(data, args, exec);
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (result === null || result === undefined) return null;
  if (field.selections === null) {
    return isObj(result) ? null : result;
  }
  if (Array.isArray(result)) {
    return result.map((item) => {
      if (item === null || item === undefined) return null;
      if (isObj(item)) return resolveSelections(item.__type, item.data, field.selections!, variables, errors, exec);
      return item;
    });
  }
  if (isObj(result)) return resolveSelections(result.__type, result.data, field.selections, variables, errors, exec);
  return result;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  const exec: Executor = { store };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  if (operationName !== undefined && operationName !== '') {
    const named = operations.find((candidate) => candidate.name === operationName);
    if (named !== undefined) operation = named;
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: Array<{ message: string }> = [];
  const data = resolveSelections(rootType, null, operation.selections, variables, errors, exec);
  return { data, errors };
}

/** Execute one GraphQL request body (a single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid operation' }] };
      const record = entry as Record<string, unknown>;
      const result = executeGraphQL(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>, typeof record.operationName === 'string' ? record.operationName : undefined);
      return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
    });
    return { status: 200, body: results };
  }
  if (typeof body !== 'object' || body === null) return { status: 400, body: { errors: [{ message: 'Invalid request body' }] } };
  const record = body as Record<string, unknown>;
  const result = executeGraphQL(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>, typeof record.operationName === 'string' ? record.operationName : undefined);
  return { status: 200, body: result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data } };
}
