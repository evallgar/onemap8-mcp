/** Helpers for turning API responses into MCP tool results. */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BinaryResult } from '../client.js';

export function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function error(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Serialise a payload for the model. Arrays are truncated to `maxRows` with an
 * explicit note, because a month of positions for a whole fleet will otherwise
 * flood the context window and crowd out the actual question.
 */
export function json(payload: unknown, maxRows: number, note?: string): CallToolResult {
  let body = payload;
  let truncation = '';

  if (Array.isArray(payload) && payload.length > maxRows) {
    body = payload.slice(0, maxRows);
    truncation =
      `\n\nShowing the first ${maxRows} of ${payload.length} rows (ONEMAP_MAX_ROWS). ` +
      'Narrow the time range or device list, or request an xlsx/mail delivery for the full set.';
  }

  const header = note ? `${note}\n\n` : '';
  const empty = Array.isArray(body) && body.length === 0 ? 'No matching records.' : undefined;
  return text(`${header}${empty ?? JSON.stringify(body, null, 2)}${truncation}`);
}

/**
 * Spreadsheets and track exports come back as bytes. Clients cannot open a
 * blob, so report size and type and point at the delivery alternatives rather
 * than dumping base64 into the transcript.
 */
export function binarySummary(result: BinaryResult, description: string): CallToolResult {
  const kb = (result.bytes.byteLength / 1024).toFixed(1);
  return text(
    [
      `${description} generated successfully.`,
      `File: ${result.filename ?? '(unnamed)'} — ${kb} KB, ${result.contentType}.`,
      '',
      'The file itself was not returned inline because binary attachments are not useful in chat.',
      'To get the file to a person, re-run with delivery="mail" so the OneMap server emails it,',
      'or fetch the same endpoint directly from a browser session.',
    ].join('\n'),
  );
}

/** Renders a device row compactly — full device JSON is mostly noise. */
export function summarizeDevice(device: {
  id: number;
  name: string;
  uniqueId: string;
  status?: string;
  lastUpdate?: string | null;
  groupId?: number | null;
  category?: string | null;
  disabled?: boolean;
}): Record<string, unknown> {
  return {
    id: device.id,
    name: device.name,
    uniqueId: device.uniqueId,
    status: device.status ?? 'unknown',
    lastUpdate: device.lastUpdate ?? null,
    groupId: device.groupId ?? null,
    category: device.category ?? null,
    ...(device.disabled ? { disabled: true } : {}),
  };
}
