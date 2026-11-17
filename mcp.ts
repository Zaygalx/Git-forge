// MCP (Model Context Protocol) over Streamable HTTP at /mcp: JSON-RPC 2.0,
// modern revision 2026-07-28 via server/discover, with the 2025-11-25
// initialize handshake as a fallback. Six fixed tools act on the shared store.

import {
  FIXED_ISO,
  VIEWER_LOGIN,
  resolveRef,
  type Store,
} from './store.ts';
import { pullMergeable, squashMergePull } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// Tool definitions (fixed array; tools/list answers byte for byte)
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> | unknown[];
}

function rpcResult(id: string | number | null, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): { status: number; body: unknown } {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolText(object: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(object) }], structuredContent: object, isError: false };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; structuredContent: null; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], structuredContent: null, isError: true };
}

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((tool) => tool.name === lower || lower.endsWith(tool.name));
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) return required;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------------------------

function callTool(store: Store, name: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: boolean } {
  const tool = findTool(name);
  if (tool === undefined) {
    return toolError(`Unknown tool: ${name}`);
  }
  const missing = missingRequired(tool, args);
  if (missing !== null) {
    return toolError(`Missing required argument: ${missing}`);
  }
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? '');

  switch (tool.name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) {
        return toolError(`Repository ${repoNameArg} already exists`);
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoNameArg, args.description === undefined ? '' : String(args.description), args.private === true);
      return toolText({ id: repo.gid, name: repo.name, owner: repo.owner, private: repo.isPrivate, default_branch: repo.defaultBranch, description: repo.description, created_at: FIXED_ISO, updated_at: FIXED_ISO });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolText({ id: repo.gid, name: repo.name, owner: repo.owner, private: repo.isPrivate, default_branch: repo.defaultBranch, description: repo.description, created_at: FIXED_ISO, updated_at: FIXED_ISO });
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, String(args.title ?? ''), args.body === undefined ? '' : String(args.body), []);
      return toolText({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, created_at: FIXED_ISO, updated_at: FIXED_ISO });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = args.state === undefined ? 'open' : String(args.state);
      const list = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, created_at: FIXED_ISO, updated_at: FIXED_ISO }));
      return toolText(list);
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const headRef = String(args.head ?? '');
      const baseRef = String(args.base ?? '');
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) return toolError(`Head or base branch not found: ${headRef} / ${baseRef}`);
      const pull = store.createPull(repo, String(args.title ?? ''), args.body === undefined ? '' : String(args.body), headRef, baseRef, headSha, baseSha);
      return toolText({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha }, mergeable: pullMergeable(repo, pull) === 'MERGEABLE', created_at: FIXED_ISO, updated_at: FIXED_ISO });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const pullNumber = Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
      if (pull === undefined) return toolError(`Pull request #${pullNumber} not found`);
      const result = squashMergePull(repo, pull);
      if (!result.ok) return toolError(result.reason ?? 'Merge failed');
      return toolText({ merged: true, sha: result.sha, message: 'Pull request successfully merged', number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------------------------

export interface McpResult {
  status: number;
  body: unknown;
  noBody?: boolean;
}

/** Handle one MCP request. `rawBody` is the request body text; `authorized` is false when the Authorization header is missing. */
export function handleMcp(store: Store, rawBody: string, authorized: boolean): McpResult {
  if (!authorized) {
    return { status: 401, body: { message: 'Requires authentication' } };
  }
  let request: RpcRequest;
  try {
    request = JSON.parse(rawBody) as RpcRequest;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = isObject(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const serverInfo = { name: 'forge', version: '1.0.0' };
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') {
    return { status: 202, body: null, noBody: true };
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // Fixed array: byte-identical on every call.
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = isObject(params.arguments) ? params.arguments : {};
    const tool = findTool(toolName);
    if (tool === undefined) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    const missing = missingRequired(tool, args);
    if (missing !== null) {
      return rpcResult(id, toolError(`Missing required argument: ${missing}`));
    }
    const result = callTool(store, toolName, args);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}