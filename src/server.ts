/**
 * Transport-agnostic server factory.
 *
 * Neither this file nor the tool layer knows how it is being reached, so the
 * stdio entrypoint and the HTTP entrypoint share one implementation and a
 * remote deployment is a config change rather than a rewrite.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OneMapClient } from './client.js';
import type { OneMapConfig } from './config.js';
import { registerAdminTools } from './tools/admin.js';
import { registerCommandTools } from './tools/commands.js';
import { registerEntityTools } from './tools/entities.js';
import { registerFleetTools } from './tools/fleet.js';
import { registerReportTools } from './tools/reports.js';

export const SERVER_NAME = 'onemap8';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `
This server exposes a OneMap8 GPS fleet-tracking installation.

Orientation:
- Every call is scoped to the permissions of the authenticated OneMap account. A 403/404 usually
  means this account cannot see the object, not that it is missing. onemap_whoami shows who you are.
- Devices are vehicles/trackers. Use onemap_list_devices to map a name the user says to an id;
  most tools also accept deviceNames directly and resolve them, failing loudly on ambiguity.
- For time ranges prefer the \`period\` parameter ("yesterday", "lastWeek", "last7Days") over
  computing ISO timestamps yourself.

Choosing a tool:
- "Where is X?" -> onemap_live_positions.
- "How far did X drive / how long was it stopped / what happened to X?" -> onemap_report.
- "Email me the report" -> onemap_report with delivery="mail".
- Raw positions are a last resort; the trips/stops/summary reports are far more readable.

Two things to be careful with:
- onemap_send_command reaches physical hardware on a vehicle. Confirm the exact device and command
  with the user in plain language before dispatching, every time.
- The API has no recurring-schedule endpoint. A "scheduled report" means an external scheduler
  (cron, n8n, or a scheduled task in the AI client) calling onemap_report with delivery="mail"
  on a cadence. Say so plainly rather than implying the server can schedule it.
`.trim();

export function createOneMapServer(config: OneMapConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const client = new OneMapClient(config);
  const ctx = { server, client };

  registerFleetTools(ctx);
  registerReportTools(ctx);
  registerEntityTools(ctx);
  registerCommandTools(ctx);
  registerAdminTools(ctx);

  registerPrompts(server);

  return server;
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'fleet_briefing',
    {
      title: 'Fleet briefing',
      description: 'Morning overview: what is online, what moved, and what raised alarms.',
      argsSchema: {
        period: z.string().optional().describe('Named period, e.g. yesterday or last24Hours.'),
      },
    },
    ({ period }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Give me a fleet briefing for ${period ?? 'yesterday'}.\n\n` +
              'Start with onemap_list_devices to see what is online versus offline or stale. ' +
              'Then run the summary report for the whole fleet over the period, and the events report ' +
              'filtered to alarms. Lead with anything that needs attention — devices that stopped ' +
              'reporting, alarms, unusual idle time — then the distance/utilisation numbers. ' +
              'Keep it short enough to read over coffee.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'vehicle_day',
    {
      title: 'Reconstruct a vehicle day',
      description: 'What one vehicle did on a given day: trips, stops, and events in order.',
      argsSchema: {
        vehicle: z.string().describe('Device name, uniqueId or id.'),
        period: z.string().optional().describe('Named period or a date.'),
      },
    },
    ({ vehicle, period }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Reconstruct what ${vehicle} did during ${period ?? 'yesterday'}.\n\n` +
              'Pull the trips and stops reports plus events for that device and period, then narrate ' +
              'the day in order: when it started, where it went, how long it stopped at each place, ' +
              'and anything anomalous (long idles, speeding, geofence crossings). Give distance and ' +
              'driving time totals at the end.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'schedule_recurring_report',
    {
      title: 'Set up a recurring report',
      description: 'Work out what a recurring emailed report needs, and how to actually schedule it.',
      argsSchema: {
        cadence: z.string().optional().describe('e.g. "every Monday 8am".'),
      },
    },
    ({ cadence }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `I want a report emailed ${cadence ?? 'every Monday morning'}.\n\n` +
              'Help me pin down which report, which devices or groups, and what time window each run ' +
              'should cover. Then run it once with delivery="mail" so I can check the output. ' +
              'Finally, be explicit that OneMap itself has no recurring-schedule API, and lay out the ' +
              'options for making it repeat — a cron job or n8n workflow calling the same endpoint, ' +
              'versus a scheduled task in the AI client — with the trade-off of each.',
          },
        },
      ],
    }),
  );
}
