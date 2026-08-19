#!/usr/bin/env node
/**
 * Streamable HTTP entrypoint — the remote, multi-user deployment.
 *
 * Runs stateless: a fresh server and transport per request, so nothing is
 * shared between callers. With ONEMAP_HTTP_PASSTHROUGH_AUTH=true each request
 * supplies its own OneMap token via the Authorization header, which means one
 * deployment serves many users and each is scoped by OneMap's own permission
 * system rather than by anything this process decides.
 *
 * Deployment notes:
 * - Terminate TLS in front of this process. Tokens travel in headers.
 * - This does not implement OAuth. Either front it with a gateway that does,
 *   or hand each user a OneMap API token to configure in their client.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { configFromEnv, loadEnvFile, type OneMapConfig } from './config.js';
import { createOneMapServer } from './server.js';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function allowedOrigins(): string[] {
  return (process.env.ONEMAP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  respondJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Per-request config: the base URL and guardrails come from the process
 * environment, the credential comes from the caller when passthrough is on.
 */
function configForRequest(base: OneMapConfig, req: IncomingMessage): OneMapConfig {
  const passthrough = !/^(0|false|no|off)$/i.test(process.env.ONEMAP_HTTP_PASSTHROUGH_AUTH ?? 'true');
  if (!passthrough) return base;

  const header = req.headers.authorization;
  if (!header) return base;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return base;

  return { ...base, token: match[1], email: undefined, password: undefined };
}

async function main(): Promise<void> {
  loadEnvFile();
  // Validate the environment once at boot so misconfiguration fails loudly
  // here rather than on the first user request.
  const baseConfig = configFromEnv();
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const origins = allowedOrigins();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        rpcError(res, 500, -32603, error instanceof Error ? error.message : 'Internal error');
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      respondJson(res, 200, { status: 'ok', upstream: baseConfig.baseUrl });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      rpcError(res, 404, -32601, `Unknown path. The MCP endpoint is ${MCP_PATH}.`);
      return;
    }

    // Browser-originated requests are only honoured for explicitly allowed
    // origins; this is the DNS-rebinding guard for local deployments.
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) {
      rpcError(res, 403, -32600, `Origin "${origin}" is not allowed. Set ONEMAP_ALLOWED_ORIGINS to permit it.`);
      return;
    }

    if (req.method !== 'POST') {
      // Stateless mode has no server-initiated stream to attach to.
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'This server is stateless; use POST for each JSON-RPC message.' },
          id: null,
        }),
      );
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      rpcError(res, 400, -32700, error instanceof Error ? error.message : 'Malformed body');
      return;
    }

    const server = createOneMapServer(configForRequest(baseConfig, req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  httpServer.listen(port, () => {
    console.error(
      `[onemap8-mcp] HTTP transport listening on :${port}${MCP_PATH} → ${baseConfig.baseUrl}\n` +
        `[onemap8-mcp] auth passthrough=${process.env.ONEMAP_HTTP_PASSTHROUGH_AUTH ?? 'true'}, ` +
        `allowed origins=${origins.length ? origins.join(', ') : '(none — browser clients rejected)'}`,
    );
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(`[onemap8-mcp] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
