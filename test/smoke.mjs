/**
 * End-to-end smoke test.
 *
 * Stands up a fake OneMap API, connects an in-memory MCP client to the real
 * server, and exercises the paths most likely to break: name resolution,
 * period arithmetic, array query encoding, mail delivery, guardrails.
 *
 *   node --test test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOneMapServer } from '../dist/server.js';

const DEVICES = [
  { id: 1, name: 'Truck 12', uniqueId: '860123456789012', status: 'online', lastUpdate: '2026-08-19T09:00:00Z', groupId: 7 },
  { id: 2, name: 'Truck 13', uniqueId: '860123456789013', status: 'offline', lastUpdate: '2026-08-18T22:10:00Z', groupId: 7 },
  { id: 3, name: 'Van A', uniqueId: '860123456789014', status: 'online', lastUpdate: '2026-08-19T09:05:00Z', groupId: null },
];

/** Captures what the MCP server actually sent upstream. */
const calls = [];

function startFakeApi() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization });

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };

    if (url.pathname === '/api/devices') return send(200, DEVICES);
    if (url.pathname === '/api/groups') return send(200, [{ id: 7, name: 'Delivery Fleet' }]);
    if (url.pathname === '/api/session') return send(200, { id: 42, name: 'Ernesto', email: 'e@example.com', administrator: true });
    if (url.pathname === '/api/server') return send(200, { version: '6.14.5', timezone: 'America/Mexico_City' });
    if (url.pathname === '/api/positions') {
      return send(200, [{ id: 99, deviceId: 1, latitude: 19.4326, longitude: -99.1332, speed: 12, fixTime: '2026-08-19T09:00:00Z', address: 'Av. Reforma' }]);
    }
    if (url.pathname === '/api/reports/trips') {
      return send(200, [{ deviceId: 1, distance: 42000, duration: 3600000, startTime: '2026-08-18T08:00:00Z' }]);
    }
    if (url.pathname === '/api/reports/summary/mail') return send(204);
    if (url.pathname === '/api/commands/send') return send(200, { id: 5, deviceId: 1, type: 'engineStop' });
    if (url.pathname === '/api/geofences' && req.method === 'POST') return send(200, { id: 3, name: 'Depot' });
    if (url.pathname === '/api/devices/404') return send(404, {});

    return send(200, []);
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function connect(overrides = {}) {
  const { server: api, port } = await startFakeApi();
  const mcp = createOneMapServer({
    baseUrl: `http://127.0.0.1:${port}/api`,
    token: 'test-token',
    readonly: false,
    allowCommands: true,
    allowDangerous: false,
    maxRows: 200,
    timeoutMs: 5000,
    ...overrides,
  });

  const client = new Client({ name: 'smoke', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async close() {
      await client.close();
      await mcp.close();
      api.close();
    },
  };
}

const textOf = (result) => result.content.map((part) => part.text).join('\n');

test('exposes a coherent tool surface', async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);

  for (const expected of ['onemap_list_devices', 'onemap_report', 'onemap_send_command', 'onemap_live_positions']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // Every tool needs a description; models select on it.
  for (const tool of tools) assert.ok(tool.description?.length > 20, `${tool.name} has a thin description`);

  const { prompts } = await client.listPrompts();
  assert.ok(prompts.length >= 3);
  await close();
});

test('lists devices and filters by status', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({ name: 'onemap_list_devices', arguments: { status: 'online' } });
  const body = textOf(result);

  assert.match(body, /Truck 12/);
  assert.match(body, /Van A/);
  assert.doesNotMatch(body, /Truck 13/, 'offline device should have been filtered out');
  await close();
});

test('resolves a device name to an id for reports', async () => {
  calls.length = 0;
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_report',
    arguments: { report: 'trips', deviceNames: ['Truck 12'], period: 'yesterday' },
  });

  assert.match(textOf(result), /Truck 12/);
  const reportCall = calls.find((call) => call.path === '/api/reports/trips');
  assert.ok(reportCall, 'no trips report call reached the API');
  assert.match(reportCall.query, /deviceId=1/, 'name was not resolved to the numeric id');
  assert.match(reportCall.query, /from=.*&to=/, 'period was not expanded into from/to');
  await close();
});

test('rejects an ambiguous device name instead of guessing', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_report',
    arguments: { report: 'trips', deviceNames: ['Truck'], period: 'today' },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /ambiguous/i);
  assert.match(textOf(result), /Truck 12.*Truck 13|Truck 13.*Truck 12/s);
  await close();
});

test('requires a target for reports', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({ name: 'onemap_report', arguments: { report: 'summary', period: 'today' } });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /at least one device or group/i);
  await close();
});

test('mail delivery queues and explains that it is one-off', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_report',
    arguments: { report: 'summary', deviceIds: [1, 2], period: 'lastWeek', delivery: 'mail' },
  });
  const body = textOf(result);

  assert.notEqual(result.isError, true);
  assert.match(body, /Queued/);
  assert.match(body, /no recurring-schedule endpoint/i, 'should not imply the server can schedule');
  await close();
});

test('encodes repeated array params the way Onemap8 expects', async () => {
  calls.length = 0;
  const { client, close } = await connect();
  await client.callTool({
    name: 'onemap_report',
    arguments: { report: 'summary', deviceIds: [1, 2], period: 'today', delivery: 'mail' },
  });

  const call = calls.find((entry) => entry.path === '/api/reports/summary/mail');
  assert.match(call.query, /deviceId=1&deviceId=2/);
  assert.match(call.auth, /^Bearer test-token$/);
  await close();
});

test('inverted explicit ranges are caught before hitting the API', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_report',
    arguments: {
      report: 'trips',
      deviceIds: [1],
      from: '2026-08-19T00:00:00Z',
      to: '2026-08-01T00:00:00Z',
    },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /inverted/);
  await close();
});

test('commands need explicit confirmation', async () => {
  calls.length = 0;
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_send_command',
    arguments: { deviceId: 1, type: 'engineStop', confirm: false },
  });

  assert.match(textOf(result), /confirm=true/);
  assert.ok(!calls.some((call) => call.path === '/api/commands/send'), 'command must not reach the API unconfirmed');
  await close();
});

test('confirmed commands dispatch', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_send_command',
    arguments: { deviceName: 'Van A', type: 'engineStop', confirm: true },
  });

  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /dispatched to device 3/);
  await close();
});

test('ONEMAP_ALLOW_COMMANDS=false blocks dispatch', async () => {
  const { client, close } = await connect({ allowCommands: false });
  const result = await client.callTool({
    name: 'onemap_send_command',
    arguments: { deviceId: 1, type: 'engineStop', confirm: true },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /ONEMAP_ALLOW_COMMANDS=false/);
  await close();
});

test('readonly mode blocks writes but allows reads', async () => {
  const { client, close } = await connect({ readonly: true });

  const write = await client.callTool({
    name: 'onemap_geofences',
    arguments: { action: 'create', data: { name: 'Depot', area: 'CIRCLE (19.4 -99.1, 500)' } },
  });
  assert.equal(write.isError, true);
  assert.match(textOf(write), /ONEMAP_READONLY=true/);

  const read = await client.callTool({ name: 'onemap_list_devices', arguments: {} });
  assert.notEqual(read.isError, true);
  await close();
});

test('dangerous operations stay gated even outside readonly', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({
    name: 'onemap_delete_positions',
    arguments: { deviceId: 1, period: 'lastMonth', confirm: true },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /ONEMAP_ALLOW_DANGEROUS/);
  await close();
});

test('upstream failures surface as readable errors', async () => {
  const { client, close } = await connect();
  const result = await client.callTool({ name: 'onemap_get_device', arguments: { deviceId: 404 } });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Not found \(404\)/);
  await close();
});

test('whoami reports both account privileges and MCP guardrails', async () => {
  const { client, close } = await connect({ allowDangerous: false });
  const body = textOf(await client.callTool({ name: 'onemap_whoami', arguments: {} }));

  assert.match(body, /"administrator": true/);
  assert.match(body, /"dangerousAllowed": false/);
  await close();
});

test('limit applies after the status filter, not before it', async () => {
  calls.length = 0;
  const { client, close } = await connect();

  // Two of the three fixtures are online. Asking for one online device must
  // return exactly one — not zero, which is what happens if `limit` is
  // delegated to the server and the status filter runs on the trimmed slice.
  const result = await client.callTool({
    name: 'onemap_list_devices',
    arguments: { status: 'online', limit: 1 },
  });
  const body = textOf(result);

  assert.notEqual(result.isError, true);
  assert.doesNotMatch(body, /No matching records/);
  assert.match(body, /2 device\(s\) matched; showing 1\./);

  const request = calls.find((call) => call.path === '/api/devices');
  assert.doesNotMatch(request.query ?? '', /limit=/, 'limit must not be delegated when filtering by status');
  await close();
});

test('limit is still delegated when there is no status filter', async () => {
  calls.length = 0;
  const { client, close } = await connect();
  await client.callTool({ name: 'onemap_list_devices', arguments: { limit: 2 } });

  const request = calls.find((call) => call.path === '/api/devices');
  assert.match(request.query, /limit=2/);
  await close();
});

test('a malformed token is reported as a token problem, not a bad request', async () => {
  const { server: api, port } = await startFakeApi();
  const mcp = createOneMapServer({
    baseUrl: `http://127.0.0.1:${port}/api`,
    token: 'truncated',
    readonly: true,
    allowCommands: false,
    allowDangerous: false,
    maxRows: 200,
    timeoutMs: 5000,
  });
  api.close();

  // Point at a closed port to force the failure, then assert on the 400 mapper
  // directly via a server that answers like the real one does.
  const cryptoFailure = createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('java.lang.NegativeArraySizeException: -102\n\tat org.onemap8.api.signature.CryptoManager.verify');
  });
  await new Promise((done) => cryptoFailure.listen(0, done));

  const mcp2 = createOneMapServer({
    baseUrl: `http://127.0.0.1:${cryptoFailure.address().port}/api`,
    token: 'truncated',
    readonly: true,
    allowCommands: false,
    allowDangerous: false,
    maxRows: 200,
    timeoutMs: 5000,
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp2.connect(b), client.connect(a)]);

  const result = await client.callTool({ name: 'onemap_list_devices', arguments: {} });
  const body = textOf(result);

  assert.equal(result.isError, true);
  assert.match(body, /token is malformed/i);
  assert.doesNotMatch(body, /rejected the parameters/, 'must not read as a parameter problem');
  assert.doesNotMatch(body, /NegativeArraySizeException/, 'raw stack trace must not reach the user');

  await client.close();
  await mcp2.close();
  await mcp.close();
  cryptoFailure.close();
});
