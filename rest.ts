// GitHub REST v3 under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, all on the shared in-memory store.

import {
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  createCommit,
  diffTrees,
  fileListAt,
  firstParentWalk,
  getObject,
  isAncestor,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  resolveRef,
  treeAtPath,
  updateTree,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: Store;
  method: string;
  query: URLSearchParams;
  body: unknown;
  host: string;
  path: string;
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User', avatar_url: '', html_url: `https://github.com/${login}` };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.gid,
    node_id: repo.gid,
    databaseId: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    language: null,
    fork: false,
    archived: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  const index = [...repo.labels.keys()].indexOf(label.name);
  return { id: index + 1, name: label.name, color: label.color, description: label.description, default: false, url: '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.idNum,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labelNames.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(repo, label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(VIEWER_LOGIN),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.idNum,
    node_id: comment.gid,
    body: comment.body,
    user: userJson(VIEWER_LOGIN),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: '',
    url: '',
  };
}

export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  const headParsed = getObject(repo, headTip);
  const baseParsed = getObject(repo, baseTip);
  const baseBase = getObject(repo, base);
  if (headParsed === undefined || baseParsed === undefined || baseBase === undefined) return 'CONFLICTING';
  const headTree = parseCommit(headParsed.data).tree;
  const baseTree = parseCommit(baseParsed.data).tree;
  const mergeTree = parseCommit(baseBase.data).tree;
  const headChanges = diffTrees(repo, mergeTree, headTree);
  const baseChanges = diffTrees(repo, mergeTree, baseTree);
  const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.idNum,
    node_id: pull.gid,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(repo.owner),
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(repo.owner),
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    draft: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const message = parsed.message.endsWith('\n') ? parsed.message.slice(0, -1) : parsed.message;
  const ident = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message,
      author: ident(parsed.author),
      committer: ident(parsed.committer),
      tree: { sha: parsed.tree },
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: parsed.parents.map((sha) => ({ sha })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

interface Page {
  items: unknown[];
  link: string | null;
}

function paginate(all: unknown[], ctx: RestContext, basePath: string): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const origin = `http://${ctx.host}`;
    const nextUrl = `${origin}${basePath}?page=${page + 1}&per_page=${perPage}`;
    const lastUrl = `${origin}${basePath}?page=${totalPages}&per_page=${perPage}`;
    link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
    if (page > 1) link += `, <${origin}${basePath}?page=1&per_page=${perPage}>; rel="first"`;
  }
  return { items, link };
}

function withLink(result: RestResult, link: string | null): RestResult {
  if (link === null) return result;
  return { ...result, headers: { ...(result.headers ?? {}), link } };
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The repository for a /repos/{owner}/{name} route, or an error result. */
function lookupRepo(ctx: RestContext, owner: string, name: string): Repo | RestResult {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function isRepo(value: Repo | RestResult): value is Repo {
  return (value as Repo).dbId !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Contents helpers
// ---------------------------------------------------------------------------------------------

function contentsPut(ctx: RestContext, repo: Repo, pathParts: string[]): RestResult {
  const input = bodyRecord(ctx.body);
  if (input === null) return err(400, 'Invalid request body');
  const message = str(input.message);
  const contentB64 = str(input.content);
  if (message === '' || contentB64 === '') return err(422, 'message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(400, 'content is not valid base64');
  }
  const branch = str(input.branch) === '' ? repo.defaultBranch : str(input.branch);
  const branchRef = `refs/heads/${branch}`;
  const branchTip = repo.refs.get(branchRef);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // A new branch starts from the default branch tip (or unborn).
  const parent = branchTip ?? (branch === repo.defaultBranch ? undefined : defaultTip);
  const parentTree = parent === undefined ? null : parseCommit(getObject(repo, parent)!.data).tree;
  const existing = treeAtPath(repo, parentTree, pathParts.join('/'));
  if (existing !== null && existing.type === 'blob') {
    const givenSha = str(input.sha);
    if (givenSha !== '' && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    if (givenSha === '') return err(422, 'sha is required to update a file');
  }
  const isUpdate = existing !== null && existing.type === 'blob';
  const blobOid = putObject(repo, 'blob', content);
  const newTree = updateTree(repo, parentTree, pathParts, blobOid);
  const parents = parent === undefined ? [] : [parent];
  const commitOid = createCommit(repo, newTree, parents, message);
  repo.refs.set(branchRef, commitOid);
  repo.version += 1;
  return {
    status: isUpdate ? 200 : 201,
    body: {
      content: {
        name: pathParts[pathParts.length - 1],
        path: pathParts.join('/'),
        sha: blobOid,
        size: content.length,
        url: '',
        html_url: '',
        download_url: null,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitOid, message, tree: { sha: newTree }, parents: parents.map((sha) => ({ sha })) },
    },
  };
}

function contentsGet(ctx: RestContext, repo: Repo, pathParts: string[]): RestResult {
  const refParam = ctx.query.get('ref');
  const tip = refParam === null || refParam === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, refParam);
  if (tip === undefined) return err(404, 'Not Found');
  const tipObject = getObject(repo, tip);
  if (tipObject === undefined || tipObject.type !== 'commit') return err(404, 'Not Found');
  const treeOid = parseCommit(tipObject.data).tree;
  const path = pathParts.join('/');
  if (path === '') {
    const entries = parseTree(getObject(repo, treeOid)!.data);
    return { status: 200, body: entries.map((entry) => dirEntryJson(repo, treeOid, entry)) };
  }
  const found = treeAtPath(repo, treeOid, path);
  if (found === null) return err(404, 'Not Found');
  if (found.type === 'tree') {
    const entries = parseTree(getObject(repo, found.oid)!.data);
    return {
      status: 200,
      body: entries.map((entry) => dirEntryJson(repo, found.oid, entry, path)),
    };
  }
  const blob = getObject(repo, found.oid);
  if (blob === undefined) return err(404, 'Not Found');
  return {
    status: 200,
    body: {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: pathParts[pathParts.length - 1],
      path,
      content: blob.data.toString('base64'),
      sha: found.oid,
    },
  };
}

function dirEntryJson(repo: Repo, _treeOid: string, entry: { mode: string; name: string; oid: string }, parentPath = ''): Record<string, unknown> {
  const path = parentPath === '' ? entry.name : `${parentPath}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const object = getObject(repo, entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (object?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: '',
    html_url: '',
    download_url: null,
  };
}

function contentsDelete(ctx: RestContext, repo: Repo, pathParts: string[]): RestResult {
  const input = bodyRecord(ctx.body);
  if (input === null) return err(400, 'Invalid request body');
  const message = str(input.message);
  if (message === '') return err(422, 'message is required');
  const branch = str(input.branch) === '' ? repo.defaultBranch : str(input.branch);
  const branchRef = `refs/heads/${branch}`;
  const branchTip = repo.refs.get(branchRef);
  if (branchTip === undefined) return err(404, 'Not Found');
  const parentTree = parseCommit(getObject(repo, branchTip)!.data).tree;
  const path = pathParts.join('/');
  const existing = treeAtPath(repo, parentTree, path);
  if (existing === null || existing.type !== 'blob') return err(404, 'Not Found');
  const givenSha = str(input.sha);
  if (givenSha !== '' && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
  const newTree = updateTree(repo, parentTree, pathParts, null);
  const commitOid = createCommit(repo, newTree, [branchTip], message);
  repo.refs.set(branchRef, commitOid);
  repo.version += 1;
  return { status: 200, body: { commit: { sha: commitOid, message } } };
}

// ---------------------------------------------------------------------------------------------
// Pull-request merge
// ---------------------------------------------------------------------------------------------

/** Squash-merge a pull request onto its base branch. Shared with the GraphQL mutation. */
export function squashMergePull(repo: Repo, pull: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (pull.state === 'closed') return { ok: false, reason: 'Pull request is already closed' };
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'Head or base branch not found' };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { ok: false, reason: 'No merge base' };
  const headTree = parseCommit(getObject(repo, headTip)!.data).tree;
  const baseTree = parseCommit(getObject(repo, baseTip)!.data).tree;
  const mergeTree = parseCommit(getObject(repo, base)!.data).tree;
  const headChanges = diffTrees(repo, mergeTree, headTree);
  const baseChanges = diffTrees(repo, mergeTree, baseTree);
  const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) {
      return { ok: false, reason: 'Merge conflict' };
    }
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeOid = createCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
  repo.version += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeOid;
  return { ok: true, sha: mergeOid };
}

function mergePull(repo: Repo, pull: Pull): RestResult {
  const result = squashMergePull(repo, pull);
  if (!result.ok) {
    const status = result.reason === 'Merge conflict' ? 405 : result.reason === 'Pull request is already closed' ? 405 : 422;
    return err(status, result.reason ?? 'Merge failed');
  }
  return { status: 200, body: { merged: true, sha: result.sha, message: 'Pull request successfully merged' } };
}

function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const headTip = resolveRef(repo, pull.headRef);
  const baseTip = resolveRef(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const headTree = parseCommit(getObject(repo, headTip)!.data).tree;
  const baseTree = parseCommit(getObject(repo, baseTip)!.data).tree;
  const changes = diffTrees(repo, baseTree, headTree);
  return changes.map((change) => {
    const oldData = change.oldOid === null ? null : (getObject(repo, change.oldOid)?.data ?? null);
    const newData = change.newOid === null ? null : (getObject(repo, change.newOid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid ?? change.oldOid,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

/** Handle one REST request. `segments` are the decoded path segments after /api/v3. */
export function handleRest(ctx: RestContext, segments: string[]): RestResult {
  const method = ctx.method;
  const [first = '', second = '', third = ''] = segments;

  // GET /api/v3/ — the API root.
  if (segments.length === 0 && method === 'GET') {
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (first === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (first === 'user' && segments.length === 1 && method === 'GET') {
    return {
      status: 200,
      body: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' },
    };
  }
  // GET/POST /api/v3/user/repos
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = ctx.store.listRepos(VIEWER_LOGIN).map((repo) => repoJson(repo));
      const page = paginate(all, ctx, '/api/v3/user/repos');
      return withLink({ status: 200, body: page.items }, page.link);
    }
    if (method === 'POST') {
      const input = bodyRecord(ctx.body);
      if (input === null) return err(400, 'Invalid request body');
      const name = str(input.name);
      if (name === '') return err(422, 'name is required');
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, input.private === true, str(input.description));
      if (repo === null) return err(422, 'Repository already exists');
      return { status: 201, body: repoJson(repo) };
    }
    return err(404, 'Not Found');
  }

  if (first !== 'repos') return err(404, 'Not Found');
  const owner = second;
  const repoName = third;
  if (owner === '' || repoName === '') return err(404, 'Not Found');
  const repoOrError = lookupRepo(ctx, owner, repoName);
  if (!isRepo(repoOrError)) return repoOrError;
  const repo = repoOrError;
  const rest = segments.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const input = bodyRecord(ctx.body);
      if (input === null) return err(400, 'Invalid request body');
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const [sub, sub2 = '', sub3 = ''] = rest;

  // Git Data refs: POST /git/refs, GET /git/refs, GET /git/refs/heads/{branch}
  if (sub === 'git' && sub2 === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const input = bodyRecord(ctx.body);
      if (input === null) return err(400, 'Invalid request body');
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
      if (!repo.objects.has(sha)) return err(422, 'object not found');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return { status: 201, body: { ref, object: { sha, type: 'commit' }, url: '', node_id: '' } };
    }
    if (method === 'GET' && rest.length === 2) {
      return {
        status: 200,
        body: [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })),
      };
    }
    if (method === 'GET' && rest.length >= 3) {
      const refName = rest.slice(2).join('/');
      const sha = repo.refs.get(refName);
      if (sha === undefined) return err(404, 'Not Found');
      return { status: 200, body: { ref: refName, object: { sha, type: 'commit' }, url: '', node_id: '' } };
    }
    return err(404, 'Not Found');
  }

  // Branches
  if (sub === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${sub2}`);
      if (sha === undefined) return err(404, 'Not Found');
      return { status: 200, body: { name: sub2, commit: { sha }, protected: false } };
    }
    return err(404, 'Not Found');
  }

  // Commits
  if (sub === 'commits' && method === 'GET' && rest.length === 1) {
    const refParam = ctx.query.get('sha');
    const tip = refParam === null || refParam === '' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, refParam);
    if (tip === undefined) return { status: 200, body: [] };
    const commits = firstParentWalk(repo, tip)
      .map((oid) => commitJson(repo, oid))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    return { status: 200, body: commits };
  }

  // Contents
  if (sub === 'contents') {
    const pathParts = rest.slice(1);
    if (method === 'GET') return contentsGet(ctx, repo, pathParts);
    if (method === 'PUT') return contentsPut(ctx, repo, pathParts);
    if (method === 'DELETE') return contentsDelete(ctx, repo, pathParts);
    return err(404, 'Not Found');
  }

  // Labels
  if (sub === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const input = bodyRecord(ctx.body);
      if (input === null) return err(400, 'Invalid request body');
      const name = str(input.name);
      if (name === '') return err(422, 'name is required');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const label: Label = { name, color: str(input.color) === '' ? 'ededed' : str(input.color), description: str(input.description) };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(repo, label) };
    }
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(repo, label)) };
    }
    return err(404, 'Not Found');
  }

  // Issues
  if (sub === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const page = paginate(
          list.map((issue) => issueJson(repo, issue)),
          ctx,
          `/api/v3/repos/${owner}/${repoName}/issues`,
        );
        return withLink({ status: 200, body: page.items }, page.link);
      }
      if (method === 'POST') {
        const input = bodyRecord(ctx.body);
        if (input === null) return err(400, 'Invalid request body');
        const title = str(input.title);
        if (title === '') return err(422, 'title is required');
        const labelNames = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        for (const name of labelNames) {
          if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
        }
        const issue = ctx.store.createIssue(repo, title, str(input.body), labelNames);
        return { status: 201, body: issueJson(repo, issue) };
      }
      return err(404, 'Not Found');
    }
    const number = Number(sub2);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        const input = bodyRecord(ctx.body);
        if (input === null) return err(400, 'Invalid request body');
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
        if (Array.isArray(input.labels)) {
          const labelNames = input.labels.filter((entry): entry is string => typeof entry === 'string');
          for (const name of labelNames) if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
          issue.labelNames = labelNames;
        }
        return { status: 200, body: issueJson(repo, issue) };
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && sub3 === 'comments') {
      if (method === 'GET') {
        return { status: 200, body: (repo.comments.get(number) ?? []).map((comment) => commentJson(comment)) };
      }
      if (method === 'POST') {
        const input = bodyRecord(ctx.body);
        if (input === null) return err(400, 'Invalid request body');
        const comment = ctx.store.addComment(repo, number, str(input.body));
        return { status: 201, body: commentJson(comment) };
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // Pulls
  if (sub === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
        const page = paginate(
          list.map((pull) => pullJson(repo, pull)),
          ctx,
          `/api/v3/repos/${owner}/${repoName}/pulls`,
        );
        return withLink({ status: 200, body: page.items }, page.link);
      }
      if (method === 'POST') {
        const input = bodyRecord(ctx.body);
        if (input === null) return err(400, 'Invalid request body');
        const title = str(input.title);
        const head = str(input.head);
        const base = str(input.base);
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const headSha = resolveRef(repo, head);
        const baseSha = resolveRef(repo, base);
        if (headSha === undefined || baseSha === undefined) return err(422, 'Head or base branch not found');
        const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (duplicate !== undefined) return err(422, 'A pull request already exists for this branch');
        const pull = ctx.store.createPull(repo, title, str(input.body), head, base, headSha, baseSha);
        return { status: 201, body: pullJson(repo, pull) };
      }
      return err(404, 'Not Found');
    }
    const number = Number(sub2);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && sub3 === 'files' && method === 'GET') {
      return { status: 200, body: pullFiles(repo, pull) };
    }
    if (rest.length === 3 && sub3 === 'merge' && method === 'PUT') {
      return mergePull(repo, pull);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
