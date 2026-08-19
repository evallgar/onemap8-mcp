/**
 * Device command dispatch.
 *
 * These tools reach real hardware — engine cutoff, door locks, output relays.
 * They are gated behind `ONEMAP_ALLOW_COMMANDS`, marked destructive, and the
 * dispatch tool requires an explicit `confirm` flag so a command is never the
 * accidental result of a vague instruction.
 */

import { z } from 'zod';
import { json, text } from '../lib/format.js';
import { resolveTargets } from '../lib/resolve.js';
import type { Command, CommandType } from '../types.js';
import { defineTool, type ToolContext } from './register.js';

export function registerCommandTools(ctx: ToolContext): void {
  const { client } = ctx;
  const maxRows = client.config.maxRows;

  defineTool(
    ctx,
    {
      name: 'onemap_command_types',
      title: 'Available command types',
      description:
        'List command types a device actually supports on its protocol. Always check this before ' +
        'dispatching — an unsupported type is rejected with a bare 400.',
      inputSchema: {
        deviceId: z.number().int().optional().describe('Omit to list every command type the server knows.'),
        deviceName: z.string().optional(),
        textChannel: z.boolean().optional().describe('true lists SMS commands instead of data-channel commands.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      let deviceId = args.deviceId;
      if (!deviceId && args.deviceName) {
        const targets = await resolveTargets(client, { deviceNames: [args.deviceName] }, { required: true });
        deviceId = targets.deviceIds[0];
      }
      const types = await client.get<CommandType[]>('/commands/types', {
        deviceId,
        textChannel: args.textChannel,
      });
      return json(types, maxRows);
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_saved_commands',
      title: 'Saved commands',
      description:
        'Manage the saved-command library: list, read, create, update, delete. Saved commands are ' +
        'templates; dispatching one is done with onemap_send_command.',
      inputSchema: {
        action: z.enum(['list', 'get', 'create', 'update', 'delete', 'supported']),
        id: z.number().int().optional().describe('Required for get/update/delete.'),
        deviceId: z.number().int().optional().describe('Filter for list, target for supported.'),
        groupId: z.number().int().optional(),
        all: z.boolean().optional().describe('Admins/managers: include every saved command on the server.'),
        command: z
          .object({
            deviceId: z.number().int().optional(),
            description: z.string().optional(),
            type: z.string().optional(),
            textChannel: z.boolean().optional(),
            attributes: z.record(z.string(), z.unknown()).optional(),
          })
          .optional()
          .describe('Body for create/update.'),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => {
      switch (args.action) {
        case 'list':
          return json(
            await client.get<Command[]>('/commands', {
              deviceId: args.deviceId,
              groupId: args.groupId,
              all: args.all,
            }),
            maxRows,
          );
        case 'supported': {
          if (!args.deviceId) throw new Error('`deviceId` is required for action="supported".');
          return json(await client.get<Command[]>('/commands/send', { deviceId: args.deviceId }), maxRows);
        }
        case 'get': {
          if (!args.id) throw new Error('`id` is required for action="get".');
          return json(await client.get<Command>(`/commands/${args.id}`), maxRows);
        }
        case 'create': {
          client.assertWritable('creating a saved command');
          if (!args.command?.type) throw new Error('`command.type` is required to create a saved command.');
          return json(await client.post<Command>('/commands', args.command), maxRows, 'Saved command created.');
        }
        case 'update': {
          client.assertWritable('updating a saved command');
          if (!args.id) throw new Error('`id` is required for action="update".');
          return json(
            await client.put<Command>(`/commands/${args.id}`, { ...args.command, id: args.id }),
            maxRows,
            'Saved command updated.',
          );
        }
        case 'delete': {
          client.assertWritable('deleting a saved command');
          if (!args.id) throw new Error('`id` is required for action="delete".');
          await client.delete(`/commands/${args.id}`);
          return text(`Saved command ${args.id} deleted.`);
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  );

  defineTool(
    ctx,
    {
      name: 'onemap_send_command',
      title: 'Send a command to a device',
      description:
        'Dispatch a command to a tracker — this physically affects the vehicle (engine immobiliser, ' +
        'door locks, outputs, sirens). Irreversible from the API side.\n\n' +
        'Requires confirm=true. Do not set confirm yourself on the strength of an ambiguous request: ' +
        'state the exact device and command to the user and get their explicit go-ahead first. ' +
        'Check onemap_command_types for the device before dispatching.',
      inputSchema: {
        deviceId: z.number().int().optional(),
        deviceName: z.string().optional().describe('Resolved server-side; rejected if ambiguous.'),
        groupId: z
          .number()
          .int()
          .optional()
          .describe('Broadcast to every device in the group. Use with extreme care.'),
        type: z.string().optional().describe('Command type, e.g. engineStop, engineResume, custom, positionSingle.'),
        savedCommandId: z.number().int().optional().describe('Dispatch an existing saved command instead of an ad-hoc one.'),
        textChannel: z.boolean().optional().describe('Send over SMS rather than the data connection.'),
        attributes: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Command parameters, e.g. { "data": "RELAY,1#" } for a custom command.'),
        confirm: z
          .boolean()
          .describe('Must be true. Explicit acknowledgement that this reaches physical hardware.'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      client.assertCommandsAllowed();

      if (args.confirm !== true) {
        return text(
          'Not sent. onemap_send_command requires confirm=true. Tell the user exactly which device and ' +
            'which command you are about to dispatch, and only proceed once they have agreed.',
        );
      }
      if (!args.type && !args.savedCommandId) {
        throw new Error('Pass either `type` (ad-hoc command) or `savedCommandId` (stored command).');
      }
      if (!args.deviceId && !args.deviceName && !args.groupId) {
        throw new Error('Pass a target: deviceId, deviceName, or groupId.');
      }

      let deviceId = args.deviceId;
      let resolutionNote: string | undefined;
      if (!deviceId && args.deviceName) {
        const targets = await resolveTargets(client, { deviceNames: [args.deviceName] }, { required: true });
        deviceId = targets.deviceIds[0];
        resolutionNote = targets.note;
      }

      const body: Command = {
        ...(args.savedCommandId ? { id: args.savedCommandId } : {}),
        ...(deviceId ? { deviceId } : {}),
        type: args.type ?? '',
        ...(args.textChannel !== undefined ? { textChannel: args.textChannel } : {}),
        ...(args.attributes ? { attributes: args.attributes } : {}),
      };

      const result = await client.post<unknown>('/commands/send', body, {
        groupId: args.groupId,
      });

      const target = args.groupId ? `group ${args.groupId}` : `device ${deviceId}`;
      return json(
        result ?? { queued: true },
        maxRows,
        `Command dispatched to ${target}.${resolutionNote ? ` ${resolutionNote}` : ''} ` +
          'A 202/queued response means the device was offline and the command will be delivered when it reconnects.',
      );
    },
  );
}
