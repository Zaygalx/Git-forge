// HTTP server: route dispatch + auth + response framing for the forge.
// Routes: GET /healthz (no auth), /api/v3/* (REST), /api/graphql (GraphQL),
// /mcp (MCP JSON-RPC), /{owner}/{repo}.git/* (git smart HTTP). Everything else
// is 404 JSON. Every response carries a non-empty X-GitHub-Request-Id and a
// Content-Length so keep-alive connections stay fast.
//
// main.ts calls createApp() with no arguments: the store is created here and
// the bearer token is read from MAKEFUN_SHOP_TOKEN. For local testing the
// optional (store, token) arguments override both.

import http from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleGraphQL } from './graphql.ts';

function sendJson(res: http.ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'X-GitHub-Request-Id': requestId, ...extraHeaders });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'X-GitHub-Request-Id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: http.ServerResponse, status: number, body: Buffer, contentType: string, requestId: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId,
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(store?: Store, token?: string): http.Server {
  const theStore = store ?? new Store();
  const theToken = token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const host = req.headers.host ?? 'localhost';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        const authorization = req.headers.authorization ?? '';
        const authorized = authorization === `Bearer ${theToken}`;
        if (!authorized) {
          sendJson(res, 401, { message: 'Requires authentication' }, requestId);
          return;
        }

        if (path.startsWith('/api/v3')) {
          const raw = await readBody(req);
          let body: unknown = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON' }, requestId);
              return;
            }
          }
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((part) => part !== '')
            .map((part) => decodeURIComponent(part));
          const result = handleRest({ store: theStore, method, query: url.searchParams, body, host, path }, segments);
          sendJson(res, result.status, result.body, requestId, result.headers ?? {});
          return;
        }

        if (path === '/api/graphql') {
          const raw = await readBody(req);
          let body: unknown = null;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] }, requestId);
            return;
          }
          const result = handleGraphQL(theStore, body);
          sendJson(res, result.status, result.body, requestId);
          return;
        }

        if (path === '/mcp') {
          const raw = await readBody(req);
          const result = handleMcp(theStore, raw.toString('utf8'), authorized);
          if (result.noBody) {
            res.writeHead(result.status, { 'X-GitHub-Request-Id': requestId });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, requestId);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const raw = await readBody(req);
          const gitProtocol2 = req.headers['git-protocol'] === 'version=2';
          const result = handleGit(theStore, method, gitMatch[1]!, gitMatch[2]!, gitMatch[3] ?? '', raw, url.searchParams, gitProtocol2);
          sendBuffer(res, result.status, result.body, result.contentType, requestId);
          return;
        }

        sendJson(res, 404, { message: 'Not found' }, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal server error' }, requestId);
        } else {
          res.end();
        }
      }
    })();
  });

  return server;
}
