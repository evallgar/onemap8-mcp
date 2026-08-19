/**
 * Unified reporting tool.
 *
 * The API exposes eight near-identical report endpoints that differ only in
 * path segment and a couple of filters. Collapsing them into one tool with a
 * `report` discriminator keeps the tool list short enough for reliable model
 * selection, and puts every report behind the same time-range and delivery
 * handling.
 */

import { z } from 'zod';
import { binarySummary, json, text } from '../lib/format.js';
import { resolveTargets } from '../lib/resolve.js';
import { periodSchema, resolveTimeRange } from '../lib/time.js';
import { defineTool, type ToolContext } from './register.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const REPORTS = {
  route: { path: '/reports/route', label: 'Route (raw track points)', supportsFile: true },
  events: { path: '/reports/events', label: 'Events (alarms, geofence crossings, ignition)', supportsFile: true },
  trips: { path: '/reports/trips', label: 'Trips (start/end, distance, duration, driver)', supportsFile: true },
  stops: { path: '/reports/stops', label: 'Stops (location, arrival, duration, idle time)', supportsFile: true },
  summary: { path: '/reports/summary', label: 'Summary (distance, engine hours, max/avg speed)', supportsFile: true },
  geofences: { path: '/reports/geofences', label: 'Geofence enter/exit intervals', supportsFile: false },
  combined: { path: '/reports/combined', label: 'Combined route + events + positions', supportsFile: false },
} as const;

type ReportKind = keyof typeof REPORTS;

export function registerReportTools(ctx: ToolContext): void {
  const { client } = ctx;
  const maxRows = client.config.maxRows;

  defineTool(
    ctx,
    {
      name: 'onemap_report',
      title: 'Run a fleet report',
      description:
        'Run any OneMap report over a time range for devices or groups.\n\n' +
        Object.entries(REPORTS)
          .map(([key, value]) => `- ${key}: ${value.label}`)
          .join('\n') +
        '\n\nDelivery: "json" returns rows inline (default), "xlsx" builds a spreadsheet, ' +
        '"mail" makes the OneMap server email the spreadsheet asynchronously to the account owner. ' +
        'Use "mail" when the user wants a report delivered rather than discussed — including as the ' +
        'action fired by a recurring schedule.',
      inputSchema: {
        report: z.enum(Object.keys(REPORTS) as [ReportKind, ...ReportKind[]]).describe('Which report to run.'),
        deviceIds: z.array(z.number().int()).optional(),
        deviceNames: z.array(z.string()).optional().describe('Device names/uniqueIds, resolved server-side.'),
        groupIds: z.array(z.number().int()).optional(),
        groupNames: z.array(z.string()).optional(),
        from: z.string().optional().describe('ISO 8601 start; pair with `to`.'),
        to: z.string().optional().describe('ISO 8601 end; pair with `from`.'),
        period: periodSchema.optional(),
        delivery: z
          .enum(['json', 'xlsx', 'mail'])
          .optional()
          .describe('How to deliver the report. Defaults to json.'),
        daily: z
          .boolean()
          .optional()
          .describe('summary report only: break the totals down per day instead of one row per device.'),
        eventTypes: z
          .array(z.string())
          .optional()
          .describe('events report only: event types to include, e.g. ["geofenceEnter","ignitionOn"]. "%" means all.'),
        alarmTypes: z
          .array(z.string())
          .optional()
          .describe('events report only: alarm types to include, e.g. ["sos","powerCut"].'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const kind = args.report as ReportKind;
      const spec = REPORTS[kind];
      const delivery: 'json' | 'xlsx' | 'mail' = args.delivery ?? 'json';

      if (delivery !== 'json' && !spec.supportsFile) {
        throw new Error(
          `The "${kind}" report has no spreadsheet/mail variant. Use delivery="json", ` +
            'or pick trips/stops/summary/events/route for a file.',
        );
      }

      const targets = await resolveTargets(client, args, { required: true });
      const range = resolveTimeRange(args);

      const query = {
        deviceId: targets.deviceIds,
        groupId: targets.groupIds,
        from: range.from,
        to: range.to,
        ...(kind === 'summary' && args.daily !== undefined ? { daily: args.daily } : {}),
        ...(kind === 'events' && args.eventTypes ? { type: args.eventTypes } : {}),
        ...(kind === 'events' && args.alarmTypes ? { alarm: args.alarmTypes } : {}),
      };

      const scope = [
        targets.deviceIds.length ? `${targets.deviceIds.length} device(s)` : null,
        targets.groupIds.length ? `${targets.groupIds.length} group(s)` : null,
      ]
        .filter(Boolean)
        .join(' and ');

      if (delivery === 'mail') {
        await client.getExpectingNoContent(`${spec.path}/mail`, query);
        return text(
          [
            `Queued: the ${kind} report for ${scope}, covering ${range.label}.`,
            'The OneMap server will email the spreadsheet to the address on the authenticated account.',
            '',
            'Note this is a one-off send. The API has no recurring-schedule endpoint — to make it repeat,',
            'drive this same call from a scheduler (cron, n8n, or a scheduled task in your AI client).',
          ].join('\n'),
        );
      }

      if (delivery === 'xlsx') {
        const file = await client.getBinary(`${spec.path}/xlsx`, query, XLSX_MIME);
        return binarySummary(file, `${kind} report for ${scope} covering ${range.label}`);
      }

      const rows = await client.get<unknown[]>(spec.path, query);
      const note = [
        `${kind} report — ${scope}, ${range.label} (${range.from} → ${range.to}).`,
        targets.note,
      ]
        .filter(Boolean)
        .join(' ');
      return json(rows, maxRows, note);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_report_devices_xlsx',
      title: 'Device inventory export',
      description:
        'Export the device inventory itself (not telemetry) as a spreadsheet, or have it emailed. ' +
        'Use for fleet audits and asset lists.',
      inputSchema: {
        delivery: z.enum(['xlsx', 'mail']).describe('xlsx builds the file; mail has the server email it.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (args.delivery === 'mail') {
        await client.getExpectingNoContent('/reports/devices/mail');
        return text('Queued: the device inventory export will be emailed to the authenticated account.');
      }
      const file = await client.getBinary('/reports/devices/xlsx', undefined, XLSX_MIME);
      return binarySummary(file, 'Device inventory export');
    },
  );
}
