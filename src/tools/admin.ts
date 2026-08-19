/**
 * Administrative surface: device/group/user records, permission links,
 * sharing, notification delivery, and the operations that need
 * ONEMAP_ALLOW_DANGEROUS because they destroy data or touch the server itself.
 */

import { z } from 'zod';
import { json, text } from '../lib/format.js';
import { resolveTargets } from '../lib/resolve.js';
import { periodSchema, resolveTimeRange } from '../lib/time.js';
import type { Device, Group, SessionUser } from '../types.js';
import { defineTool, type ToolContext } from './register.js';

export function registerAdminTools(ctx: ToolContext): void {
  const { client } = ctx;
  const maxRows = client.config.maxRows;

  defineTool(
    ctx,
    {
      name: 'onemap_manage_device',
      title: 'Create / update / delete a device',
      description:
        'Write operations on device records. `uniqueId` must match the identifier the hardware reports — ' +
        'changing it silently detaches the tracker from its history.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete', 'setAccumulators']),
        id: z.number().int().optional().describe('Required for update, delete and setAccumulators.'),
        data: z
          .object({
            name: z.string().optional(),
            uniqueId: z.string().optional(),
            groupId: z.number().int().nullable().optional(),
            phone: z.string().optional(),
            model: z.string().optional(),
            contact: z.string().optional(),
            category: z.string().optional(),
            disabled: z.boolean().optional(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          })
          .optional()
          .describe('On update, send the complete object — omitted fields are cleared.'),
        totalDistance: z.number().optional().describe('setAccumulators: odometer in metres.'),
        hours: z.number().optional().describe('setAccumulators: engine hours in milliseconds.'),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      switch (args.action) {
        case 'create': {
          client.assertWritable('creating a device');
          if (!args.data?.name || !args.data?.uniqueId) {
            throw new Error('`data.name` and `data.uniqueId` are both required to create a device.');
          }
          return json(await client.post<Device>('/devices', args.data), maxRows, 'Device created.');
        }
        case 'update': {
          client.assertWritable('updating a device');
          if (!args.id) throw new Error('`id` is required for action="update".');
          return json(
            await client.put<Device>(`/devices/${args.id}`, { ...args.data, id: args.id }),
            maxRows,
            'Device updated.',
          );
        }
        case 'delete': {
          client.assertDangerousAllowed('deleting a device (this discards its history)');
          if (!args.id) throw new Error('`id` is required for action="delete".');
          await client.delete(`/devices/${args.id}`);
          return text(`Device ${args.id} deleted.`);
        }
        case 'setAccumulators': {
          client.assertWritable('overwriting device accumulators');
          if (!args.id) throw new Error('`id` is required for action="setAccumulators".');
          await client.put(`/devices/${args.id}/accumulators`, {
            deviceId: args.id,
            totalDistance: args.totalDistance,
            hours: args.hours,
          });
          return text(
            `Accumulators updated for device ${args.id}. ` +
              'Odometer and engine-hour totals are now anchored to these values.',
          );
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_manage_group',
      title: 'Create / update / delete a group',
      description: 'Write operations on device groups. Groups can nest via `groupId`.',
      inputSchema: {
        action: z.enum(['create', 'update', 'delete']),
        id: z.number().int().optional(),
        data: z
          .object({
            name: z.string().optional(),
            groupId: z.number().int().nullable().optional().describe('Parent group, for nesting.'),
            attributes: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      switch (args.action) {
        case 'create': {
          client.assertWritable('creating a group');
          if (!args.data?.name) throw new Error('`data.name` is required.');
          return json(await client.post<Group>('/groups', args.data), maxRows, 'Group created.');
        }
        case 'update': {
          client.assertWritable('updating a group');
          if (!args.id) throw new Error('`id` is required.');
          return json(
            await client.put<Group>(`/groups/${args.id}`, { ...args.data, id: args.id }),
            maxRows,
            'Group updated.',
          );
        }
        case 'delete': {
          client.assertWritable('deleting a group');
          if (!args.id) throw new Error('`id` is required.');
          await client.delete(`/groups/${args.id}`);
          return text(`Group ${args.id} deleted. Its devices are now ungrouped.`);
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_users',
      title: 'Manage users',
      description:
        'List, read, create and update user accounts (admin/manager accounts only). ' +
        'Passwords set here are transmitted to the OneMap server in the request body — prefer having ' +
        'the person set their own password through the password-reset flow.',
      inputSchema: {
        action: z.enum(['list', 'get', 'create', 'update', 'delete']),
        id: z.number().int().optional(),
        userId: z.number().int().optional().describe('list: fetch managed users of this manager.'),
        all: z.boolean().optional().describe('list: admins can request every user on the server.'),
        data: z
          .object({
            name: z.string().optional(),
            email: z.string().optional(),
            password: z.string().optional(),
            phone: z.string().optional(),
            readonly: z.boolean().optional(),
            administrator: z.boolean().optional(),
            disabled: z.boolean().optional(),
            deviceLimit: z.number().int().optional(),
            userLimit: z.number().int().optional(),
            deviceReadonly: z.boolean().optional(),
            limitCommands: z.boolean().optional(),
            expirationTime: z.string().optional(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      switch (args.action) {
        case 'list':
          return json(
            await client.get<SessionUser[]>('/users', { userId: args.userId, all: args.all }),
            maxRows,
          );
        case 'get': {
          if (!args.id) throw new Error('`id` is required.');
          return json(await client.get<SessionUser>(`/users/${args.id}`), maxRows);
        }
        case 'create': {
          client.assertWritable('creating a user account');
          if (!args.data?.email || !args.data?.name) {
            throw new Error('`data.name` and `data.email` are required to create a user.');
          }
          return json(await client.post<SessionUser>('/users', args.data), maxRows, 'User created.');
        }
        case 'update': {
          client.assertWritable('updating a user account');
          if (!args.id) throw new Error('`id` is required.');
          return json(
            await client.put<SessionUser>(`/users/${args.id}`, { ...args.data, id: args.id }),
            maxRows,
            'User updated.',
          );
        }
        case 'delete': {
          client.assertDangerousAllowed('deleting a user account');
          if (!args.id) throw new Error('`id` is required.');
          await client.delete(`/users/${args.id}`);
          return text(`User ${args.id} deleted.`);
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_permissions',
      title: 'Link and unlink objects',
      description:
        'Grant or revoke access by linking two objects — this is how a user gets a device, a device ' +
        'gets a geofence, a notification gets attached, and so on.\n\n' +
        'Pass exactly two id fields. Order matters: userId is always first; ' +
        'e.g. {userId: 3, deviceId: 8} gives user 3 access to device 8, while ' +
        '{deviceId: 8, geofenceId: 16} attaches geofence 16 to device 8.',
      inputSchema: {
        action: z.enum(['link', 'unlink', 'linkBulk', 'unlinkBulk', 'query']),
        userId: z.number().int().optional(),
        deviceId: z.number().int().optional(),
        groupId: z.number().int().optional(),
        geofenceId: z.number().int().optional(),
        notificationId: z.number().int().optional(),
        calendarId: z.number().int().optional(),
        attributeId: z.number().int().optional(),
        driverId: z.number().int().optional(),
        managedUserId: z.number().int().optional(),
        commandId: z.number().int().optional(),
        items: z
          .array(z.record(z.string(), z.number().int()))
          .optional()
          .describe('For linkBulk/unlinkBulk: an array of permission objects, each with exactly two ids.'),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const keys = [
        'userId',
        'deviceId',
        'groupId',
        'geofenceId',
        'notificationId',
        'calendarId',
        'attributeId',
        'driverId',
        'managedUserId',
        'commandId',
      ] as const;

      const permission: Record<string, number> = {};
      for (const key of keys) {
        if (args[key] !== undefined) permission[key] = args[key];
      }

      if (args.action === 'query') {
        return json(await client.get<unknown[]>('/permissions', permission as never), maxRows);
      }

      const bulk = args.action === 'linkBulk' || args.action === 'unlinkBulk';
      if (bulk) {
        if (!args.items?.length) throw new Error('`items` is required for bulk actions.');
      } else if (Object.keys(permission).length !== 2) {
        throw new Error(
          `A permission link needs exactly two ids, got ${Object.keys(permission).length}: ` +
            `${Object.keys(permission).join(', ') || '(none)'}.`,
        );
      }

      const path = bulk ? '/permissions/bulk' : '/permissions';
      const body = bulk ? args.items : permission;

      if (args.action === 'link' || args.action === 'linkBulk') {
        client.assertWritable('creating a permission link');
        await client.post(path, body);
        return text(bulk ? `Linked ${args.items!.length} pair(s).` : `Linked ${JSON.stringify(permission)}.`);
      }

      client.assertWritable('removing a permission link');
      await client.delete(path, undefined, body);
      return text(bulk ? `Unlinked ${args.items!.length} pair(s).` : `Unlinked ${JSON.stringify(permission)}.`);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_share',
      title: 'Create a share link',
      description:
        'Generate a temporary read-only share link for a device or group — useful for giving a customer ' +
        'live visibility on a delivery without creating an account. The link is a bearer credential: ' +
        'anyone holding it can see the tracking, so treat it as sensitive.',
      inputSchema: {
        target: z.enum(['device', 'group']),
        id: z.number().int().describe('Device or group id.'),
        expiration: z.string().describe('ISO 8601 timestamp when the link stops working.'),
      },
      annotations: { destructiveHint: false },
    },
    async (args) => {
      client.assertWritable('creating a share link');
      const path = args.target === 'device' ? '/share/device' : '/share/group';
      const key = args.target === 'device' ? 'deviceId' : 'groupId';
      const result = await client.post<unknown>(path, undefined, {
        [key]: args.id,
        expiration: args.expiration,
      });
      return json(result, maxRows, `Share link created for ${args.target} ${args.id}, valid until ${args.expiration}.`);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_send_notification',
      title: 'Send a notification',
      description:
        'Send an ad-hoc notification through a configured channel (mail, sms, firebase, telegram, ...). ' +
        'This reaches real people — confirm the recipient and wording with the user before sending.',
      inputSchema: {
        notificator: z.string().describe('Channel id from onemap_notifications action="channels".'),
        userId: z.number().int().optional().describe('Recipient user id. Defaults to the authenticated account.'),
        message: z.string().optional().describe('Message body.'),
        subject: z.string().optional(),
        test: z.boolean().optional().describe('true sends the channel test message instead of a custom one.'),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      client.assertWritable('sending a notification');
      if (args.test) {
        await client.post(`/notifications/test/${encodeURIComponent(args.notificator)}`);
        return text(`Test message sent over "${args.notificator}".`);
      }
      await client.post(`/notifications/send/${encodeURIComponent(args.notificator)}`, {
        userId: args.userId,
        message: args.message,
        subject: args.subject,
      });
      return text(`Notification sent over "${args.notificator}".`);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_session_token',
      title: 'Create or revoke an API token',
      description:
        'Mint a new API token for the authenticated account, or revoke the current one. ' +
        'A token is a full-access credential for that account — never paste one into a chat, a file, ' +
        'or anywhere it will be stored in plain text.',
      inputSchema: {
        action: z.enum(['create', 'revoke']),
        expiration: z.string().optional().describe('ISO 8601 expiry for the new token.'),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      client.assertWritable('managing API tokens');
      if (args.action === 'revoke') {
        await client.post('/session/token/revoke');
        return text('Token revoked.');
      }
      await client.post<string>('/session/token', undefined, { expiration: args.expiration });
      return text(
        'A new API token was created on the server. It is deliberately not printed here — ' +
          'retrieve it from the OneMap UI so it is never written into this transcript.',
      );
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_stream_url',
      title: 'Live video stream URL',
      description:
        'Build the HLS playlist URL for a dashcam channel on a device. Returns the URL; playback happens ' +
        'in a video player, not here.',
      inputSchema: {
        deviceId: z.number().int().optional(),
        deviceName: z.string().optional(),
        channel: z.string().describe('Camera channel id, e.g. "1".'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let deviceId = args.deviceId;
      if (!deviceId && args.deviceName) {
        const targets = await resolveTargets(client, { deviceNames: [args.deviceName] }, { required: true });
        deviceId = targets.deviceIds[0];
      }
      if (!deviceId) throw new Error('Pass deviceId or deviceName.');
      const url = `${client.config.baseUrl}/stream/${deviceId}/${encodeURIComponent(args.channel)}/live.m3u8`;
      return text(
        `HLS playlist for device ${deviceId}, channel ${args.channel}:\n${url}\n\n` +
          'Requires the same authentication as the API, so it must be opened by an authenticated player.',
      );
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_server_settings',
      title: 'Server settings and maintenance',
      description:
        'Read server configuration, or perform server-level maintenance. Reads are always available; ' +
        'update, reboot and cache operations are administrative and gated behind ONEMAP_ALLOW_DANGEROUS.',
      inputSchema: {
        action: z.enum(['get', 'update', 'timezones', 'cache', 'gc', 'reboot']),
        data: z
          .object({
            registration: z.boolean().optional(),
            readonly: z.boolean().optional(),
            deviceReadonly: z.boolean().optional(),
            limitCommands: z.boolean().optional(),
            map: z.string().optional(),
            timezone: z.string().optional(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          })
          .optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      switch (args.action) {
        case 'get':
          return json(await client.get<unknown>('/server'), maxRows);
        case 'timezones':
          return json(await client.get<string[]>('/server/timezones'), maxRows);
        case 'update': {
          client.assertDangerousAllowed('changing server-wide settings');
          return json(await client.put<unknown>('/server', args.data), maxRows, 'Server settings updated.');
        }
        case 'cache': {
          client.assertDangerousAllowed('inspecting the server cache');
          return json(await client.get<unknown>('/server/cache'), maxRows);
        }
        case 'gc': {
          client.assertDangerousAllowed('forcing garbage collection');
          await client.get('/server/gc');
          return text('Garbage collection requested.');
        }
        case 'reboot': {
          client.assertDangerousAllowed('rebooting the OneMap server');
          await client.post('/server/reboot');
          return text('Server reboot requested. Tracking ingestion will be interrupted until it comes back up.');
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_delete_positions',
      title: 'Delete position history',
      description:
        'Permanently delete stored positions for a device over a time range. There is no undo and no ' +
        'export step — the telemetry is gone. Gated behind ONEMAP_ALLOW_DANGEROUS and requires confirm=true.\n\n' +
        'Do not call this on your own initiative. The user must have asked for exactly this deletion.',
      inputSchema: {
        deviceId: z.number().int(),
        from: z.string().optional(),
        to: z.string().optional(),
        period: periodSchema.optional(),
        confirm: z.boolean().describe('Must be true. Acknowledges that the data is destroyed irreversibly.'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      client.assertDangerousAllowed('deleting position history');
      if (args.confirm !== true) {
        return text('Not deleted. This tool requires confirm=true and an explicit request from the user.');
      }
      const range = resolveTimeRange(args);
      await client.delete('/positions', {
        deviceId: args.deviceId,
        from: range.from,
        to: range.to,
      });
      return text(
        `Deleted positions for device ${args.deviceId} covering ${range.label} (${range.from} → ${range.to}).`,
      );
    },
  );
}
