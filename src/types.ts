/** Subset of the OneMap8 schemas the tool layer actually reads. */

export interface Device {
  id: number;
  name: string;
  uniqueId: string;
  status?: string;
  disabled?: boolean;
  lastUpdate?: string | null;
  positionId?: number | null;
  groupId?: number | null;
  phone?: string | null;
  model?: string | null;
  contact?: string | null;
  category?: string | null;
  attributes?: Record<string, unknown>;
}

export interface Position {
  id: number;
  deviceId: number;
  protocol?: string;
  deviceTime?: string;
  fixTime?: string;
  serverTime?: string;
  outdated?: boolean;
  valid?: boolean;
  latitude: number;
  longitude: number;
  altitude?: number;
  speed?: number;
  course?: number;
  address?: string | null;
  accuracy?: number;
  network?: unknown;
  attributes?: Record<string, unknown>;
}

export interface Group {
  id: number;
  name: string;
  groupId?: number | null;
  attributes?: Record<string, unknown>;
}

export interface Event {
  id: number;
  type: string;
  eventTime: string;
  deviceId: number;
  positionId?: number | null;
  geofenceId?: number | null;
  maintenanceId?: number | null;
  attributes?: Record<string, unknown>;
}

export interface Command {
  id?: number;
  deviceId?: number;
  description?: string;
  type: string;
  textChannel?: boolean;
  attributes?: Record<string, unknown>;
}

export interface CommandType {
  type: string;
}

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  administrator?: boolean;
  readonly?: boolean;
  deviceReadonly?: boolean;
  limitCommands?: boolean;
  deviceLimit?: number;
  userLimit?: number;
  expirationTime?: string | null;
  attributes?: Record<string, unknown>;
}

export interface ServerInfo {
  id?: number;
  registration?: boolean;
  readonly?: boolean;
  deviceReadonly?: boolean;
  limitCommands?: boolean;
  version?: string;
  map?: string | null;
  timezone?: string | null;
  attributes?: Record<string, unknown>;
}
