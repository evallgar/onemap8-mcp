/**
 * Device and group name resolution.
 *
 * Users talk about "Truck 12" or a plate number; the API only takes numeric
 * ids. Resolving names here means the model does not have to chain a lookup
 * call before every report, and ambiguous names fail loudly instead of
 * silently picking the wrong vehicle.
 */

import type { OneMapClient } from '../client.js';
import type { Device, Group } from '../types.js';

export interface ResolvedTargets {
  deviceIds: number[];
  groupIds: number[];
  /** Human-readable note describing what the names resolved to. */
  note?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

async function resolveDeviceNames(client: OneMapClient, names: string[]): Promise<{
  ids: number[];
  notes: string[];
}> {
  const devices = await client.get<Device[]>('/devices');
  const ids: number[] = [];
  const notes: string[] = [];

  for (const name of names) {
    const needle = normalize(name);
    const exact = devices.filter(
      (device) => normalize(device.name) === needle || normalize(device.uniqueId) === needle,
    );
    const matches = exact.length > 0
      ? exact
      : devices.filter((device) => normalize(device.name).includes(needle));

    if (matches.length === 0) {
      const sample = devices
        .slice(0, 10)
        .map((device) => device.name)
        .join(', ');
      throw new Error(
        `No device matches "${name}". Known devices include: ${sample}${devices.length > 10 ? ', …' : ''}. ` +
          'Use onemap_list_devices to see the full list.',
      );
    }
    if (matches.length > 1) {
      const options = matches.map((device) => `${device.name} (id ${device.id})`).join(', ');
      throw new Error(
        `"${name}" is ambiguous — it matches ${matches.length} devices: ${options}. ` +
          'Re-run with the exact name or the numeric id.',
      );
    }
    const match = matches[0]!;
    ids.push(match.id);
    notes.push(`"${name}" → ${match.name} (id ${match.id})`);
  }

  return { ids, notes };
}

async function resolveGroupNames(client: OneMapClient, names: string[]): Promise<{
  ids: number[];
  notes: string[];
}> {
  const groups = await client.get<Group[]>('/groups');
  const ids: number[] = [];
  const notes: string[] = [];

  for (const name of names) {
    const needle = normalize(name);
    const exact = groups.filter((group) => normalize(group.name) === needle);
    const matches = exact.length > 0
      ? exact
      : groups.filter((group) => normalize(group.name).includes(needle));

    if (matches.length === 0) {
      const sample = groups.map((group) => group.name).slice(0, 10).join(', ');
      throw new Error(`No group matches "${name}". Known groups: ${sample || '(none)'}.`);
    }
    if (matches.length > 1) {
      const options = matches.map((group) => `${group.name} (id ${group.id})`).join(', ');
      throw new Error(`"${name}" is ambiguous — it matches: ${options}. Use the numeric id.`);
    }
    const match = matches[0]!;
    ids.push(match.id);
    notes.push(`"${name}" → group ${match.name} (id ${match.id})`);
  }

  return { ids, notes };
}

export async function resolveTargets(
  client: OneMapClient,
  input: {
    deviceIds?: number[];
    deviceNames?: string[];
    groupIds?: number[];
    groupNames?: string[];
  },
  options: { required?: boolean } = {},
): Promise<ResolvedTargets> {
  const deviceIds = [...(input.deviceIds ?? [])];
  const groupIds = [...(input.groupIds ?? [])];
  const notes: string[] = [];

  if (input.deviceNames?.length) {
    const resolved = await resolveDeviceNames(client, input.deviceNames);
    deviceIds.push(...resolved.ids);
    notes.push(...resolved.notes);
  }
  if (input.groupNames?.length) {
    const resolved = await resolveGroupNames(client, input.groupNames);
    groupIds.push(...resolved.ids);
    notes.push(...resolved.notes);
  }

  if (options.required && deviceIds.length === 0 && groupIds.length === 0) {
    throw new Error(
      'This report needs at least one device or group. Pass deviceIds/deviceNames or groupIds/groupNames.',
    );
  }

  return {
    deviceIds: [...new Set(deviceIds)],
    groupIds: [...new Set(groupIds)],
    note: notes.length > 0 ? `Resolved: ${notes.join('; ')}` : undefined,
  };
}
