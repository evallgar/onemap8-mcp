/** Shared plumbing for tool registration. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { GuardrailError, OneMapError, type OneMapClient } from '../client.js';
import { error } from '../lib/format.js';

export interface ToolContext {
  server: McpServer;
  client: OneMapClient;
}

export interface ToolSpec<Shape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Registers a tool with uniform error handling.
 *
 * Failures are returned as `isError` results rather than thrown, so the model
 * sees a readable explanation (and can correct a bad device name or date range)
 * instead of the client surfacing an opaque protocol error.
 */
export function defineTool<Shape extends ZodRawShape>(
  { server }: ToolContext,
  spec: ToolSpec<Shape>,
  handler: (args: any) => Promise<CallToolResult>,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        openWorldHint: true,
        ...spec.annotations,
      },
    },
    (async (args: any) => {
      try {
        return await handler(args);
      } catch (caught) {
        if (caught instanceof GuardrailError) {
          return error(caught.message);
        }
        if (caught instanceof OneMapError) {
          return error(`${caught.message}\n(${caught.method} ${caught.path})`);
        }
        return error(caught instanceof Error ? caught.message : String(caught));
      }
    }) as Parameters<McpServer['registerTool']>[2],
  );
}
