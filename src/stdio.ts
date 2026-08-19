#!/usr/bin/env node
/**
 * stdio entrypoint — the local, single-user deployment.
 *
 * Configured in Claude Desktop / Claude Code / any stdio MCP client, with
 * credentials supplied through the environment.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv, loadEnvFile } from './config.js';
import { createOneMapServer } from './server.js';

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  const config = configFromEnv();
  const server = createOneMapServer(config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // stdout carries the protocol; diagnostics must go to stderr.
  console.error(
    `[onemap8-mcp] connected to ${config.baseUrl} ` +
      `(readonly=${config.readonly}, commands=${config.allowCommands}, dangerous=${config.allowDangerous})` +
      `${envFile ? `\n[onemap8-mcp] config loaded from ${envFile}` : ''}`,
  );

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(`[onemap8-mcp] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
