/**
 * Thin HTTP client over the OneMap8 REST API.
 *
 * Everything the tool layer needs goes through here so that auth, timeouts,
 * array query-parameter encoding and error shaping stay in one place.
 */

import type { OneMapConfig } from './config.js';

export class OneMapError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'OneMapError';
  }
}

/** Guardrail violation — never reaches the network. */
export class GuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailError';
  }
}

export type QueryValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | Array<string | number | boolean>;

export type Query = Record<string, QueryValue>;

export interface BinaryResult {
  contentType: string;
  filename?: string;
  bytes: Uint8Array;
}

function authHeader(config: OneMapConfig): string {
  if (config.token) return `Bearer ${config.token}`;
  const basic = Buffer.from(`${config.email}:${config.password}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

/**
 * Onemap8 expects repeated keys for array params (`?deviceId=1&deviceId=2`),
 * which is exactly what `URLSearchParams.append` produces.
 */
export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        params.append(key, String(item));
      }
    } else if (value instanceof Date) {
      params.append(key, value.toISOString());
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export class OneMapClient {
  constructor(readonly config: OneMapConfig) {}

  /** Throws when the current configuration forbids a mutating call. */
  assertWritable(action: string): void {
    if (this.config.readonly) {
      throw new GuardrailError(
        `Refused: ${action} is a write operation and this server is running with ONEMAP_READONLY=true.`,
      );
    }
  }

  assertCommandsAllowed(): void {
    this.assertWritable('sending a device command');
    if (!this.config.allowCommands) {
      throw new GuardrailError(
        'Refused: device command dispatch is disabled (ONEMAP_ALLOW_COMMANDS=false). ' +
          'Commands can physically affect a vehicle, so they must be enabled explicitly.',
      );
    }
  }

  assertDangerousAllowed(action: string): void {
    this.assertWritable(action);
    if (!this.config.allowDangerous) {
      throw new GuardrailError(
        `Refused: ${action} is irreversible or infrastructure-level and requires ` +
          'ONEMAP_ALLOW_DANGEROUS=true on the MCP server.',
      );
    }
  }

  private async send(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const url = `${this.config.baseUrl}${path}${buildQuery(options.query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: authHeader(this.config),
      Accept: options.accept ?? 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OneMapError(
          `Request timed out after ${this.config.timeoutMs}ms`,
          408,
          method,
          path,
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new OneMapError(`Could not reach the OneMap server: ${detail}`, 0, method, path);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OneMapError(describeStatus(response.status, text), response.status, method, path, text);
    }
    return response;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const response = await this.send('GET', path, { query });
    return parseJson<T>(response);
  }

  async post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    const response = await this.send('POST', path, { body, query });
    return parseJson<T>(response);
  }

  async put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    const response = await this.send('PUT', path, { body, query });
    return parseJson<T>(response);
  }

  async delete(path: string, query?: Query, body?: unknown): Promise<void> {
    await this.send('DELETE', path, { query, body });
  }

  /** For spreadsheet / KML / CSV / GPX downloads. */
  async getBinary(path: string, query: Query | undefined, accept: string): Promise<BinaryResult> {
    const response = await this.send('GET', path, { query, accept });
    const buffer = await response.arrayBuffer();
    return {
      contentType: response.headers.get('content-type') ?? accept,
      filename: filenameFromDisposition(response.headers.get('content-disposition')),
      bytes: new Uint8Array(buffer),
    };
  }

  /**
   * Fetches the authenticated user.
   *
   * `GET /session` is the one endpoint that does not honour the
   * `Authorization` header: it reports on the *cookie* session, and answers
   * 404 when there is none. Token clients have to pass the token as a query
   * parameter instead, which is the documented mechanism but does put the
   * credential into the server's access log — so it is only attempted as a
   * fallback, never on the first try.
   */
  async getSessionUser<T>(): Promise<T> {
    try {
      return await this.get<T>('/session');
    } catch (caught) {
      const recoverable = caught instanceof OneMapError && (caught.status === 404 || caught.status === 401);
      if (!recoverable || !this.config.token) throw caught;
      return this.get<T>('/session', { token: this.config.token });
    }
  }

  /**
   * `type=mail` report endpoints answer 204 with no body; treat that as
   * "queued" rather than trying to parse a response.
   */
  async getExpectingNoContent(path: string, query?: Query): Promise<void> {
    await this.send('GET', path, { query });
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

const BAD_TOKEN_MESSAGE =
  'The OneMap API token is malformed. The server could not even decode it, which usually means it was ' +
  'truncated or partially copied. Generate a fresh token (Settings → Preferences) and update ONEMAP_TOKEN.';

/**
 * A structurally invalid token does not produce a 401 — it fails inside the
 * server's crypto layer and surfaces as a 400 carrying a raw Java stack trace.
 * Left alone that reads as "your parameters are wrong", sending people to
 * debug the wrong thing entirely.
 */
function looksLikeTokenDecodeFailure(body: string): boolean {
  return /CryptoManager|NegativeArraySizeException|ArrayIndexOutOfBoundsException|signature/i.test(body);
}

function describeStatus(status: number, body: string): string {
  const detail = body.trim().slice(0, 500);
  switch (status) {
    case 400:
      return looksLikeTokenDecodeFailure(body)
        ? BAD_TOKEN_MESSAGE
        : `Bad request (400). The server rejected the parameters${detail ? `: ${detail}` : '.'}`;
    case 401:
      return 'Unauthorized (401). The configured OneMap credentials were rejected — the token is well-formed but not valid (most often expired, revoked, or from another server). Generate a fresh one.';
    case 403:
      return 'Forbidden (403). The account is authenticated but lacks permission for this object.';
    case 404:
      return 'Not found (404). The object does not exist, or this account cannot see it.';
    case 429:
      return 'Rate limited (429) by the OneMap server. Retry in a moment.';
    default:
      return `OneMap API error ${status}${detail ? `: ${detail}` : ''}`;
  }
}
