# Step one — the hosted endpoint

Puts the MCP server on the machine already running your Onemap8 instance, reachable at
`https://YOUR-HOST/mcp`.

**Nothing new is provisioned.** No second machine, no subdomain, no extra certificate, no database,
no third-party service. One more Node process on an existing box, listening on `127.0.0.1:3000`,
plus three lines in the Apache vhost you already have.

Customers authenticate with their own Onemap8 API token, so each one sees exactly the vehicles
their account already permits. The server holds no credential of its own.

> **The one risk:** your web app is live traffic on this host. An Apache syntax error blocks the
> reload for *every* site, not just this one. `configtest` before every reload is what prevents
> that, and it is in the steps below.

---

## 1. Install

```bash
sudo useradd --system --home /opt/onemap8-mcp --shell /usr/sbin/nologin onemap-mcp
sudo git clone https://github.com/evallgar/onemap8-mcp.git /opt/onemap8-mcp
cd /opt/onemap8-mcp
sudo npm ci && sudo npm run build
sudo chown -R onemap-mcp:onemap-mcp /opt/onemap8-mcp
```

Node 20+ required (`node -v`).

## 2. Configure

```bash
sudo -u onemap-mcp cp .env.example .env
sudo -u onemap-mcp chmod 600 .env
sudo -u onemap-mcp nano .env
```

```ini
# Same machine, so talk to the app directly and skip the TLS round-trip.
ONEMAP_URL=http://127.0.0.1:8082/api

# Empty on purpose. Every request carries its own token.
ONEMAP_TOKEN=
ONEMAP_HTTP_PASSTHROUGH_AUTH=true

# A shared endpoint should not be able to change anything or reach hardware.
ONEMAP_READONLY=true
ONEMAP_ALLOW_COMMANDS=false
ONEMAP_ALLOW_DANGEROUS=false

PORT=3000
ONEMAP_ALLOWED_ORIGINS=
```

With `ONEMAP_TOKEN` empty and passthrough on, the service has no credential of its own — a request
without a valid customer token cannot reach any data.

## 3. Start it

```bash
sudo cp deploy/onemap8-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onemap8-mcp
sudo systemctl status onemap8-mcp

curl -s localhost:3000/mcp/health      # {"status":"ok",...}
```

If this works, the hard part is done — everything after it is one Apache edit.

## 4. Expose it through Apache

Back up the vhost first:

```bash
sudo cp /etc/apache2/sites-available/YOUR-SITE.conf /root/YOUR-SITE.conf.bak
sudo a2enmod proxy proxy_http headers env setenvif
```

Open the `<VirtualHost *:443>` block that serves your app and paste in the block from
[`apache-snippet.conf`](apache-snippet.conf) — **above** the existing `ProxyPass / http://localhost:8082/`
line, because Apache takes the first matching rule and `/` matches everything.

```bash
sudo apache2ctl configtest        # must say "Syntax OK"
sudo systemctl reload apache2
```

If `configtest` fails, fix it or restore the backup. Do not reload on a failed configtest.

## 5. Verify

```bash
curl -s https://YOUR-HOST/mcp/health

curl -s -X POST https://YOUR-HOST/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer YOUR_ONEMAP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300
```

Then check the things that actually matter:

- **Your web app still works.** Load it in a browser. This is the one that counts.
- **A request with no token is refused.**
- **Another user's token returns only their devices.**

## 6. Give a customer the URL

They add a custom connector in Claude (Settings → Connectors) pointing at `https://YOUR-HOST/mcp`,
and supply their own Onemap8 token from Settings → Preferences.

That token step is the friction OAuth removes later. Everything here stays as-is when OAuth lands —
it goes into this same process, not a new one.

---

## Operating

```bash
sudo journalctl -u onemap8-mcp -f
sudo systemctl restart onemap8-mcp        # after a rebuild
```

Deploy a change: `git pull && npm ci && npm run build && sudo systemctl restart onemap8-mcp`.

## Rolling back

Entirely additive — remove the snippet from the vhost and the endpoint is gone. Nothing about the
web app changes either way.

```bash
sudo cp /root/YOUR-SITE.conf.bak /etc/apache2/sites-available/YOUR-SITE.conf
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo systemctl disable --now onemap8-mcp
```

## Known limits at this stage

- **No rate limiting.** A misbehaving client generates load on your tracking server. Worth adding
  `mod_ratelimit` or a reverse-proxy limit before this goes past a handful of customers.
- **Token auth only.** Customers paste a token; OAuth is the next step.
- **Customer fleet data reaches the AI provider** when they ask a question. Tell them before they
  connect.
