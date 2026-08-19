# OneMap8 MCP Server

Exposes a OneMap8 fleet tracking installation to Claude, ChatGPT, and any
other MCP client, so people can ask questions in plain language instead of driving the report UI:

> Where is Truck 12 right now?
> How many kilometres did the delivery fleet cover last week?
> Email me the trips report for the vans, Monday to Friday.
> Which vehicles raised alarms overnight?

**32 tools** covering the full API surface — devices, positions, all seven report types, geofences,
drivers, maintenance, notifications, calendars, users, permissions, and device command dispatch.

## Quick start

```bash
npm install && npm run build
```

Copy `.env.example` to `.env` and fill in your server URL and a token:

```bash
cp .env.example .env
```

Verify the connection end to end:

```bash
npm test
```

## Authentication

The plugin never has more access than the OneMap account behind it. Whatever devices, groups and
reports that user can see through the web UI is exactly what the model can reach — OneMap's own
permission system does the enforcement, and there is no separate privilege model to keep in sync.

Two options, set in `.env`:

- **`ONEMAP_TOKEN`** (recommended) — an API token minted for the account. Sent as a bearer token.
  Revocable without changing the password.
- **`ONEMAP_EMAIL` + `ONEMAP_PASSWORD`** — basic auth. Works, but leaves the password in plain text
  on disk; use it only to get going.

## Connecting a client

### Claude Desktop / Claude Code (stdio)

Add to `claude_desktop_config.json` (or `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "onemap8": {
      "command": "node",
      "args": ["/absolute/path/to/ai-plugin/dist/stdio.js"],
      "env": {
        "ONEMAP_URL": "https://mcp.onemap8.com/api",
        "ONEMAP_TOKEN": "your-token-here",
        "ONEMAP_ALLOW_COMMANDS": "false"
      }
    }
  }
}
```

### Remote / ChatGPT connector (HTTP)

```bash
npm run start:http
```

Serves Streamable HTTP on `POST /mcp` (health check at `/health`). It runs **stateless** — a fresh
server per request, nothing shared between callers — so one deployment can serve many users.

With `ONEMAP_HTTP_PASSTHROUGH_AUTH=true` (the default) each request's `Authorization: Bearer <token>`
header supplies that caller's own OneMap token, so every user is scoped to their own permissions
rather than sharing one service account.

Before exposing it publicly:

- Terminate TLS in front of the process — tokens travel in headers.
- Set `ONEMAP_ALLOWED_ORIGINS` if browser-based clients will connect; unlisted origins are refused.
- This does **not** implement OAuth. Either front it with a gateway that does, or hand each user a
  OneMap API token to paste into their client.

## Guardrails

The account's own permissions are the real security boundary. These flags are the second layer —
they limit what the *model* can do with that account, which is a different question from what the
account is allowed to do.

| Variable | Default | Effect |
| --- | --- | --- |
| `ONEMAP_READONLY` | `false` | Refuses every write. Reports and queries still work. |
| `ONEMAP_ALLOW_COMMANDS` | `true` | Set `false` to disable device command dispatch entirely. |
| `ONEMAP_ALLOW_DANGEROUS` | `false` | Gates position deletion, user deletion, device deletion, server settings and reboot. |
| `ONEMAP_MAX_ROWS` | `200` | Truncates large result sets before they flood the context window. |

Two tools additionally require an explicit `confirm: true` argument, on top of the flags above:
`onemap_send_command` and `onemap_delete_positions`.

**On device commands specifically:** `onemap_send_command` reaches physical hardware — engine
immobilisers, door locks, relays. Enabling it means a language model is one tool call away from
stopping a vehicle. It is on by default because you asked for the full surface, but consider
`ONEMAP_ALLOW_COMMANDS=false` for any deployment where users other than you can reach it, and
leaving command dispatch to the operators' own UI.

## Scheduled reports

**The OneMap API has no recurring-schedule endpoint.** It can email a report *once*, on request —
`onemap_report` with `delivery: "mail"` hits `/reports/{type}/mail`, and the server emails the
spreadsheet asynchronously to the account owner.

Making that repeat is an external scheduler calling the same thing on a cadence:

| Approach | Good for | Watch out for |
| --- | --- | --- |
| **cron / n8n** hitting `/reports/{type}/mail` directly | Production. Reliable, centralised, independent of any AI client, survives the plugin being uninstalled. | A little backend work; lives outside this repo. |
| **Scheduled task in Claude or ChatGPT** firing a prompt that calls `onemap_report` | Personal use, quick experiments, reports where you want the model to summarise before sending. | Depends on the AI platform's task infra — tasks can be paused or lost, and timing is not guaranteed. |

For anything a business depends on, use the first. The `schedule_recurring_report` prompt walks
through picking the report and parameters, runs it once so you can check the output, and then lays
out both options.

An n8n version is roughly: Schedule Trigger → HTTP Request `GET {ONEMAP_URL}/reports/trips/mail`
with `deviceId`, `from`, `to` and an `Authorization: Bearer` header.

## Tool reference

**Fleet state** — `onemap_list_devices`, `onemap_get_device`, `onemap_list_groups`,
`onemap_live_positions`, `onemap_position_history`, `onemap_get_event`, `onemap_geocode`,
`onemap_whoami`, `onemap_statistics`, `onemap_audit_log`

**Reports** — `onemap_report` (route, events, trips, stops, summary, geofences, combined ×
json/xlsx/mail), `onemap_report_devices_xlsx`

**Configuration** — `onemap_geofences`, `onemap_drivers`, `onemap_maintenance`, `onemap_calendars`,
`onemap_notifications`, `onemap_computed_attributes`, `onemap_orders` (each takes an `action`:
list/get/create/update/delete)

**Commands** — `onemap_command_types`, `onemap_saved_commands`, `onemap_send_command`

**Administration** — `onemap_manage_device`, `onemap_manage_group`, `onemap_users`,
`onemap_permissions`, `onemap_share`, `onemap_send_notification`, `onemap_session_token`,
`onemap_stream_url`, `onemap_server_settings`, `onemap_delete_positions`

### Design notes

Two decisions worth knowing about when extending this:

- **Names resolve to ids server-side.** Tools accept `deviceNames: ["Truck 12"]` and look the id up,
  because users say names and models guess ids. Ambiguous names are rejected with the candidates
  listed rather than resolved to a guess — picking the wrong vehicle silently is worse than failing.
- **One report tool, not eight.** The seven report endpoints differ only by path segment, so they
  are one tool with a `report` discriminator. Short tool lists measurably improve model selection
  accuracy; the same reasoning collapses entity CRUD into one `action`-dispatched tool each.

Named periods (`period: "lastWeek"`) are resolved server-side too — weeks start Monday — because
date arithmetic is a reliable source of quiet model errors.

Two API quirks worth knowing before you touch these code paths, both found by testing against the
live server rather than by reading the spec:

- **`GET /session` ignores `Authorization: Bearer`.** It reports on the *cookie* session and answers
  404 when there is none. Token clients must pass `?token=`, which `OneMapClient.getSessionUser()`
  does as a fallback only — that puts the credential in the server's access log, so it is never the
  first attempt.
- **`id` on `/positions` means *position* id, not device id**, and `deviceId` requires an explicit
  `from`/`to`. "Latest position" is therefore `GET /positions` with no parameters, filtered
  client-side. Passing a device id as `id` gets a 500 (`NullPointerException`) from the server.

## Development

```bash
npm run dev        # tsc --watch
npm test           # build + smoke tests against a mock API
npm run inspect    # MCP Inspector against the stdio server
```

`test/smoke.mjs` stands up a fake OneMap API and drives the real server through an in-memory MCP
client, covering name resolution, period expansion, array query encoding, mail delivery, and every
guardrail.
