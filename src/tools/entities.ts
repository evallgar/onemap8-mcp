/**
 * CRUD for the configuration entities that all share Onemap8's
 * list/get/create/update/delete shape: geofences, drivers, maintenance,
 * calendars, notifications, computed attributes and orders.
 *
 * One action-dispatched tool per entity rather than five tools each — 7 tools
 * instead of 35, without losing any capability.
 */

import { z, type ZodRawShape } from 'zod';
import { json, text } from '../lib/format.js';
import { defineTool, type ToolContext } from './register.js';

interface EntitySpec {
  name: string;
  path: string;
  title: string;
  description: string;
  /** Extra query params accepted by the list endpoint. */
  listFilters?: ZodRawShape;
  body: ZodRawShape;
  extra?: string;
}

const ENTITIES: EntitySpec[] = [
  {
    name: 'onemap_geofences',
    path: '/geofences',
    title: 'Geofences',
    description:
      'Manage geofences. Areas are WKT strings: CIRCLE (lat lon, radiusMetres), ' +
      'POLYGON ((lat lon, lat lon, ...)) or LINESTRING (lat lon, ...) — note Onemap8 writes ' +
      'latitude before longitude, the opposite of standard WKT.',
    listFilters: {
      deviceId: z.number().int().optional().describe('Only geofences linked to this device.'),
      groupId: z.number().int().optional(),
      refresh: z.boolean().optional(),
    },
    body: {
      name: z.string().optional(),
      description: z.string().optional(),
      area: z.string().optional().describe('WKT geometry, e.g. "CIRCLE (19.4326 -99.1332, 500)".'),
      calendarId: z.number().int().optional().describe('Restricts when the geofence is active.'),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: 'onemap_drivers',
    path: '/drivers',
    title: 'Drivers',
    description: 'Manage drivers. `uniqueId` is the iButton/RFID value the tracker reports.',
    listFilters: {
      deviceId: z.number().int().optional(),
      groupId: z.number().int().optional(),
    },
    body: {
      name: z.string().optional(),
      uniqueId: z.string().optional().describe('iButton / RFID identifier reported by the device.'),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: 'onemap_maintenance',
    path: '/maintenance',
    title: 'Maintenance schedules',
    description:
      'Manage maintenance rules — service intervals keyed on odometer, engine hours or elapsed time. ' +
      '`start` and `period` are in the base unit of `type` (metres for totalDistance, ms for hours).',
    listFilters: {
      deviceId: z.number().int().optional(),
      groupId: z.number().int().optional(),
    },
    body: {
      name: z.string().optional(),
      type: z.string().optional().describe('Attribute driving the schedule, e.g. totalDistance or hours.'),
      start: z.number().optional().describe('Value at which the first service is due.'),
      period: z.number().optional().describe('Interval between services.'),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: 'onemap_calendars',
    path: '/calendars',
    title: 'Calendars',
    description:
      'Manage calendars that restrict when geofences and notifications are active. `data` is a ' +
      'base64-encoded iCalendar (RFC 5545) document.',
    body: {
      name: z.string().optional(),
      data: z.string().optional().describe('Base64-encoded iCalendar content.'),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
  },
  {
    name: 'onemap_notifications',
    path: '/notifications',
    title: 'Notification rules',
    description:
      'Manage notification rules — which events trigger alerts and over which channels. ' +
      'Use action="types" and action="channels" to discover valid values before creating a rule.',
    listFilters: {
      deviceId: z.number().int().optional(),
      groupId: z.number().int().optional(),
      all: z.boolean().optional(),
    },
    body: {
      type: z.string().optional().describe('Event type, e.g. geofenceExit, ignitionOn, deviceOverspeed.'),
      always: z.boolean().optional().describe('Apply to every device rather than linked devices only.'),
      notificators: z.string().optional().describe('Comma-separated channels, e.g. "web,mail,firebase".'),
      commandId: z.number().int().optional().describe('Saved command to fire when this triggers.'),
      calendarId: z.number().int().optional(),
      description: z.string().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
    extra: 'types|channels',
  },
  {
    name: 'onemap_computed_attributes',
    path: '/attributes/computed',
    title: 'Computed attributes',
    description:
      'Manage computed attributes — server-side expressions deriving new values from raw telemetry. ' +
      'Use action="test" with a deviceId to evaluate an expression before saving it.',
    listFilters: {
      deviceId: z.number().int().optional(),
      groupId: z.number().int().optional(),
      all: z.boolean().optional(),
    },
    body: {
      description: z.string().optional(),
      attribute: z.string().optional().describe('Target attribute name the result is stored under.'),
      expression: z.string().optional().describe('Expression evaluated against each position.'),
      type: z.string().optional().describe('Result type: string, number or boolean.'),
    },
    extra: 'test',
  },
  {
    name: 'onemap_orders',
    path: '/orders',
    title: 'Orders',
    description: 'Manage delivery/dispatch orders linked to devices.',
    listFilters: {
      deviceId: z.number().int().optional(),
      groupId: z.number().int().optional(),
      all: z.boolean().optional(),
    },
    body: {
      uniqueId: z.string().optional(),
      description: z.string().optional(),
      fromAddress: z.string().optional(),
      toAddress: z.string().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
  },
];

export function registerEntityTools(ctx: ToolContext): void {
  const { client } = ctx;
  const maxRows = client.config.maxRows;

  for (const entity of ENTITIES) {
    const actions = ['list', 'get', 'create', 'update', 'delete'];
    if (entity.extra === 'types|channels') actions.push('types', 'channels', 'test');
    if (entity.extra === 'test') actions.push('test');

    defineTool(
      ctx,
      {
        name: entity.name,
        title: entity.title,
        description: entity.description,
        inputSchema: {
          action: z.enum(actions as [string, ...string[]]).describe('Operation to perform.'),
          id: z.number().int().optional().describe('Required for get, update and delete.'),
          ...(entity.listFilters ?? {}),
          data: z
            .object(entity.body)
            .optional()
            .describe('Payload for create/update. On update, omitted fields are cleared by the server — send the full object.'),
          testDeviceId: z
            .number()
            .int()
            .optional()
            .describe('Device to evaluate against for action="test".'),
        },
        annotations: { destructiveHint: true },
      },
      async (args) => {
        const filters: Record<string, unknown> = {};
        for (const key of Object.keys(entity.listFilters ?? {})) {
          if (args[key] !== undefined) filters[key] = args[key];
        }

        switch (args.action) {
          case 'list':
            return json(await client.get<unknown[]>(entity.path, filters as never), maxRows);

          case 'get': {
            if (!args.id) throw new Error('`id` is required for action="get".');
            return json(await client.get<unknown>(`${entity.path}/${args.id}`), maxRows);
          }

          case 'create': {
            client.assertWritable(`creating a ${entity.title.toLowerCase()} record`);
            if (!args.data) throw new Error('`data` is required for action="create".');
            return json(await client.post<unknown>(entity.path, args.data), maxRows, 'Created.');
          }

          case 'update': {
            client.assertWritable(`updating a ${entity.title.toLowerCase()} record`);
            if (!args.id) throw new Error('`id` is required for action="update".');
            if (!args.data) throw new Error('`data` is required for action="update".');
            return json(
              await client.put<unknown>(`${entity.path}/${args.id}`, { ...args.data, id: args.id }),
              maxRows,
              'Updated.',
            );
          }

          case 'delete': {
            client.assertWritable(`deleting a ${entity.title.toLowerCase()} record`);
            if (!args.id) throw new Error('`id` is required for action="delete".');
            await client.delete(`${entity.path}/${args.id}`);
            return text(`Deleted ${entity.title.toLowerCase()} ${args.id}.`);
          }

          case 'types':
            return json(await client.get<unknown[]>('/notifications/types'), maxRows);

          case 'channels':
            return json(await client.get<unknown[]>('/notifications/notificators'), maxRows);

          case 'test': {
            if (entity.name === 'onemap_notifications') {
              client.assertWritable('sending a test notification');
              await client.post('/notifications/test');
              return text('Test notification sent to the authenticated account over all configured channels.');
            }
            if (!args.data) throw new Error('`data` (the expression to evaluate) is required for action="test".');
            return json(
              await client.post<unknown>('/attributes/computed/test', args.data, {
                deviceId: args.testDeviceId,
              }),
              maxRows,
              'Expression evaluated against the latest position.',
            );
          }

          default:
            throw new Error(`Unknown action "${args.action}".`);
        }
      },
    );
  }
}
