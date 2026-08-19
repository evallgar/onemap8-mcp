/**
 * Runtime configuration for the OneMap8 MCP server.
 *
 * Config is resolved per session rather than read from `process.env` deep in
 * the call stack, so the same tool layer can serve a single-user stdio process
 * and a multi-tenant HTTP deployment where every request carries its own token.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads `.env` from the package root before config is read.
 *
 * MCP clients launch the server as a bare subprocess with no shell profile, so
 * the environment is whatever the client's config block supplies and nothing
 * more. Reading `.env` here means credentials live in one gitignored file
 * instead of being pasted into every client's JSON config.
 *
 * Real environment variables always win, so a client that does set them
 * explicitly (or an HTTP deployment using a secret manager) is unaffected.
 */
export function loadEnvFile(): string | undefined {
  const candidates = [
    process.env.ONEMAP_ENV_FILE,
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
    resolve(process.cwd(), '.env'),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
      return path;
    } catch {
      // A malformed .env should not be fatal — explicit env vars may still be
      // enough to run, and configFromEnv will report anything actually missing.
    }
  }
  return undefined;
}

export interface OneMapConfig {
  /** Base URL including the `/api` suffix, no trailing slash. */
  baseUrl: string;
  /** Bearer token, mutually exclusive with email/password. */
  token?: string;
  email?: string;
  password?: string;
  readonly: boolean;
  allowCommands: boolean;
  allowDangerous: boolean;
  maxRows: number;
  timeoutMs: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`ONEMAP_URL must start with http:// or https:// (got "${raw}")`);
  }
  // A common misconfiguration is pointing at the web UI rather than the API.
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OneMapConfig {
  const url = env.ONEMAP_URL;
  if (!url) {
    throw new Error(
      'ONEMAP_URL is not set. Point it at your OneMap8 API, e.g. https://tracking.example.com/api',
    );
  }

  const token = env.ONEMAP_TOKEN?.trim() || undefined;
  const email = env.ONEMAP_EMAIL?.trim() || undefined;
  const password = env.ONEMAP_PASSWORD || undefined;

  if (!token && !(email && password)) {
    throw new Error(
      'No credentials configured. Set ONEMAP_TOKEN, or both ONEMAP_EMAIL and ONEMAP_PASSWORD.',
    );
  }

  return {
    baseUrl: normalizeBaseUrl(url),
    token,
    email,
    password,
    readonly: bool(env.ONEMAP_READONLY, false),
    allowCommands: bool(env.ONEMAP_ALLOW_COMMANDS, true),
    allowDangerous: bool(env.ONEMAP_ALLOW_DANGEROUS, false),
    maxRows: int(env.ONEMAP_MAX_ROWS, 200),
    timeoutMs: int(env.ONEMAP_TIMEOUT_MS, 30_000),
  };
}
