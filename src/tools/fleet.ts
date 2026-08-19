/** Read-only fleet state: devices, groups, live positions, history, events. */

import { z } from 'zod';
import type { OneMapClient } from '../client.js';
import { json, summarizeDevice, text, binarySummary } from '../lib/format.js';
import { resolveTargets } from '../lib/resolve.js';
import { periodSchema, resolveTimeRange } from '../lib/time.js';
import type { Device, Event, Group, Position, ServerInfo, SessionUser } from '../types.js';
import { defineTool, type ToolContext } from './register.js';

const deviceSelector = {
  deviceIds: z.array(z.number().int()).optional().describe('Numeric device ids.'),
  deviceNames: z
    .array(z.string())
    .optional()
    .describe('Device names or uniqueIds; resolved server-side. Ambiguous names are rejected.'),
  groupIds: z.array(z.number().int()).optional().describe('Numeric group ids.'),
  groupNames: z.array(z.string()).optional().describe('Group names; resolved server-side.'),
};

export function registerFleetTools(ctx: ToolContext): void {
  const { client } = ctx;
  const maxRows = client.config.maxRows;

  defineTool(
    ctx,
    {
      name: 'onemap_list_devices',
      title: 'List devices',
      description:
        'List the vehicles/trackers this account can see, with connection status and last-update time. ' +
        'Start here when the user names a vehicle you do not have an id for.',
      inputSchema: {
        keyword: z.string().optional().describe('Free-text filter on name/uniqueId.'),
        status: z
          .enum(['online', 'offline', 'unknown'])
          .optional()
          .describe('Filter by current connection status (applied client-side).'),
        groupId: z.number().int().optional().describe('Only devices in this group.'),
        includeAttributes: z
          .boolean()
          .optional()
          .describe('Include the raw custom attributes blob. Off by default — it is verbose.'),
        limit: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      // `status` is not a server-side filter, so `limit` cannot be delegated
      // alongside it: the server would trim the list first and the status
      // filter would then run against an arbitrary slice, silently returning
      // too few rows (often none). Limit after filtering instead.
      const devices = await client.get<Device[]>('/devices', {
        keyword: args.keyword,
        groupId: args.groupId,
        limit: args.status ? undefined : args.limit,
      });

      const filtered = args.status
        ? devices.filter((device) => (device.status ?? 'unknown') === args.status)
        : devices;

      const limited = args.limit ? filtered.slice(0, args.limit) : filtered;
      const rows = args.includeAttributes ? limited : limited.map(summarizeDevice);

      const note =
        limited.length < filtered.length
          ? `${filtered.length} device(s) matched; showing ${limited.length}.`
          : `${filtered.length} device(s).`;
      return json(rows, maxRows, note);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_get_device',
      title: 'Get one device',
      description: 'Fetch the full record for a single device, including custom attributes.',
      inputSchema: {
        deviceId: z.number().int().optional(),
        deviceName: z.string().optional().describe('Name or uniqueId, if the id is unknown.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (!args.deviceId && !args.deviceName) {
        throw new Error('Pass either deviceId or deviceName.');
      }
      const targets = await resolveTargets(
        client,
        { deviceIds: args.deviceId ? [args.deviceId] : [], deviceNames: args.deviceName ? [args.deviceName] : [] },
        { required: true },
      );
      const device = await client.get<Device>(`/devices/${targets.deviceIds[0]}`);
      return json(device, maxRows, targets.note);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_list_groups',
      title: 'List groups',
      description: 'List device groups (fleets, depots, customers) visible to this account.',
      inputSchema: {
        keyword: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const groups = await client.get<Group[]>('/groups', { keyword: args.keyword });
      return json(groups, maxRows, `${groups.length} group(s).`);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_live_positions',
      title: 'Live positions',
      description:
        'Current known position for one, several, or all devices — coordinates, speed, address and ignition state. ' +
        'This is the "where is X right now" tool.',
      inputSchema: {
        ...deviceSelector,
        includeAttributes: z
          .boolean()
          .optional()
          .describe('Include raw telemetry attributes (ignition, fuel, odometer, ...).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const targets = await resolveTargets(client, args);

      // `/positions` with no parameters returns the latest position for every
      // accessible device. Its `id` parameter means *position* id, not device
      // id, and `deviceId` requires an explicit from/to window — so the only
      // correct way to answer "where is X now" is to fetch the latest set and
      // filter here.
      const [devices, positions] = await Promise.all([
        client.get<Device[]>('/devices'),
        client.get<Position[]>('/positions'),
      ]);

      let wanted = new Set(targets.deviceIds);
      if (wanted.size === 0 && targets.groupIds.length > 0) {
        for (const device of devices) {
          if (device.groupId != null && targets.groupIds.includes(device.groupId)) wanted.add(device.id);
        }
        if (wanted.size === 0) return text('That group contains no devices.');
      }

      const nameById = new Map(devices.map((device) => [device.id, device.name]));
      const selected = wanted.size > 0
        ? positions.filter((position) => wanted.has(position.deviceId))
        : positions;

      const rows = selected.map((position) => ({
        deviceId: position.deviceId,
        device: nameById.get(position.deviceId) ?? `#${position.deviceId}`,
        fixTime: position.fixTime,
        latitude: position.latitude,
        longitude: position.longitude,
        speedKnots: position.speed,
        course: position.course,
        address: position.address ?? null,
        valid: position.valid,
        ...(args.includeAttributes ? { attributes: position.attributes } : {}),
      }));

      // A device that has never reported has no position at all. Saying so
      // beats returning an empty list that reads as "nothing to report".
      const missing = [...wanted].filter(
        (id) => !selected.some((position) => position.deviceId === id),
      );
      const notes = [
        targets.note,
        missing.length > 0
          ? `No position on record for: ${missing
              .map((id) => `${nameById.get(id) ?? `#${id}`} (id ${id})`)
              .join(', ')}. The device has not reported since the server last restarted, or has never reported.`
          : undefined,
      ].filter(Boolean);

      if (rows.length === 0 && missing.length > 0) {
        return text(notes.join(' '));
      }

      return json(rows, maxRows, notes.length > 0 ? notes.join(' ') : undefined);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_position_history',
      title: 'Position history',
      description:
        'Raw position track for a single device over a time range. Verbose — prefer onemap_report with ' +
        'report="trips" or "route" for anything a person will read.',
      inputSchema: {
        deviceId: z.number().int().optional(),
        deviceName: z.string().optional(),
        from: z.string().optional().describe('ISO 8601 start. Use with `to`.'),
        to: z.string().optional().describe('ISO 8601 end. Use with `from`.'),
        period: periodSchema.optional(),
        format: z
          .enum(['json', 'kml', 'csv', 'gpx'])
          .optional()
          .describe('json returns rows to read; the others produce a downloadable track file.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const targets = await resolveTargets(
        client,
        { deviceIds: args.deviceId ? [args.deviceId] : [], deviceNames: args.deviceName ? [args.deviceName] : [] },
        { required: true },
      );
      const range = resolveTimeRange(args);
      const query = { deviceId: targets.deviceIds[0], from: range.from, to: range.to };
      const note = `Positions for ${range.label} (${range.from} → ${range.to}).`;

      const format = args.format ?? 'json';
      if (format !== 'json') {
        const accept =
          format === 'csv' ? 'text/csv' : format === 'gpx' ? 'application/gpx+xml' : 'application/vnd.google-earth.kml+xml';
        const file = await client.getBinary(`/positions/${format}`, query, accept);
        return binarySummary(file, `${format.toUpperCase()} track`);
      }

      const positions = await client.get<Position[]>('/positions', query);
      const rows = positions.map((position) => ({
        fixTime: position.fixTime,
        latitude: position.latitude,
        longitude: position.longitude,
        speedKnots: position.speed,
        course: position.course,
        address: position.address ?? null,
      }));
      return json(rows, maxRows, `${note}${targets.note ? ` ${targets.note}` : ''}`);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_get_event',
      title: 'Get event',
      description: 'Fetch a single event by id (as referenced from a report or notification).',
      inputSchema: { eventId: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async (args) => json(await client.get<Event>(`/events/${args.eventId}`), maxRows),
  );

  defineTool(
    ctx,
    {
      name: 'onemap_geocode',
      title: 'Reverse geocode',
      description: 'Turn latitude/longitude into a street address using the server-configured geocoder.',
      inputSchema: {
        latitude: z.number(),
        longitude: z.number(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const address = await client.get<string>('/server/geocode', {
        latitude: args.latitude,
        longitude: args.longitude,
      });
      return text(typeof address === 'string' ? address : JSON.stringify(address));
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_whoami',
      title: 'Session and server info',
      description:
        'Who this connection is authenticated as, what privileges the account holds, and which server ' +
        'version it is talking to. Useful when a call fails with a permission error.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [user, server] = await Promise.all([
        client.getSessionUser<SessionUser>(),
        client.get<ServerInfo>('/server').catch(() => undefined),
      ]);
      return json(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            administrator: user.administrator ?? false,
            readonly: user.readonly ?? false,
            deviceReadonly: user.deviceReadonly ?? false,
            limitCommands: user.limitCommands ?? false,
            deviceLimit: user.deviceLimit,
            expirationTime: user.expirationTime ?? null,
          },
          server: server ? { version: server.version, timezone: server.timezone } : 'unavailable',
          mcpGuardrails: {
            readonly: client.config.readonly,
            commandsAllowed: client.config.allowCommands,
            dangerousAllowed: client.config.allowDangerous,
            maxRows: client.config.maxRows,
          },
        },
        maxRows,
      );
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_statistics',
      title: 'Server statistics',
      description: 'Aggregate server usage statistics over a period (admin accounts only).',
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        period: periodSchema.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const range = resolveTimeRange(args);
      const stats = await client.get<unknown[]>('/statistics', { from: range.from, to: range.to });
      return json(stats, maxRows, `Statistics for ${range.label}.`);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_audit_log',
      title: 'Audit log',
      description: 'Who changed what and when (admin accounts only).',
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        period: periodSchema.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const range = resolveTimeRange(args);
      const entries = await client.get<unknown[]>('/audit', { from: range.from, to: range.to });
      return json(entries, maxRows, `Audit entries for ${range.label}.`);
    },
  );
}
