# OneMap8 AI Assistant — tester guide

You're testing a connector that lets Claude (or ChatGPT) answer questions about the OneMap8 fleet
in plain language, instead of clicking through report screens.

Ask things like:

> Which vehicles are online right now?
> Where is MOBI 034?
> How far did the MOBI buses drive last week?
> Email me the trips report for group 3, Monday to Friday.
> Which vehicles raised alarms overnight?

**You will only ever see the vehicles your own OneMap account can already see.** The connector uses
your personal token and inherits your existing permissions — it cannot show you more than the web
UI does, and your colleagues cannot see your data through theirs.

---

## First: get your personal token

1. Open OneMap8 and go to **Settings → Preferences**.
2. Pick an **expiration date** — choose one several months out, or the connector will quietly stop
   working when it lapses.
3. **Generate**, then **copy** the token.

Treat it like your password: it grants access to your account. Don't paste it into a chat message,
a ticket, a shared doc, or a screen-share. If it leaks, come back to this screen and generate a new
one — that invalidates the old one.

---

## Setup

Runs on your own machine. Needs **Node 20+** (`node -v` to check).

```bash
git clone "https://grabita.visualstudio.com/Onemap8%20MCP%20Server/_git/Onemap8%20MCP%20Server" onemap8-mcp
cd onemap8-mcp
npm run setup
```

Keep the quotes — the URL contains encoded spaces. If the clone asks for credentials, use your Azure
DevOps email and a personal access token with **Code (Read)** scope, not your account password.

`npm run setup` installs, builds, asks for your API URL and token (hidden input), verifies both
against the live server, and prints the exact config block to paste into your client. It writes
`.env` with permissions `600` and starts you in read-only mode.

To confirm afterwards:

```bash
claude mcp list
```

`onemap8: … - ✓ Connected` means it's working. Anything else, see Troubleshooting.

---

## What to test

Please try these and report what happens — especially anything that reads as confidently wrong.

**Everyday questions**
- Where a specific vehicle is now; whether the address and time look right.
- Distance / driving time for a vehicle or a group over a period, cross-checked against the web UI.
- Stops: does "how long was it parked at X" match reality?
- Alarms and events overnight or over a weekend.

**Things that should fail cleanly**
- A vehicle name that doesn't exist — you should get a clear "no device matches", not a wrong guess.
- An ambiguous name like "MOBI" — should list the candidates and ask, not silently pick one.
- A vehicle that has never reported — should say so, not show an empty result.

**Worth reporting**
- Numbers that disagree with the OneMap web UI for the same vehicle and period.
- Any answer stated confidently without the underlying data supporting it.
- Anything slow (over ~10 seconds).
- Wording that reads oddly in Spanish or English.

### What it deliberately will not do

- **Recurring/scheduled reports.** It can email a report *once*, on request. Nothing in OneMap
  schedules a repeat — that needs a separate cron/n8n job. If the assistant ever implies it has set
  up a recurring schedule, that's a bug worth reporting.
- **Vehicle commands** (engine stop, etc.) are disabled for testers. If you're ever prompted to
  confirm one, stop and report it.
- **Writes** — creating or editing geofences, drivers, users — are off during testing.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unauthorized (401)` | Token expired or revoked | Generate a fresh token and re-run `npm run setup` |
| `token is malformed` | Token truncated when copied | Copy the whole string, re-run `npm run setup` |
| `Not found (404)` on a vehicle | Your account can't see it | Ask an admin to grant your user access to that device |
| `claude mcp list` shows "Failed" | Build missing or wrong path | `npm run build`, check the path in `.mcp.json` is absolute |
| Tools don't appear in the chat | Client not restarted | Fully quit and reopen Claude — connectors load at startup |
| "0 devices" but you know you have some | Filters combined oddly | Report it with the exact question you asked |

## Reporting a problem

Include:

1. The exact question you asked.
2. What it answered.
3. What you expected, and how you know (e.g. "the web UI says 43 km for the same day").
4. Vehicle name and time period.

Never include your token.
