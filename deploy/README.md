# Deploying the hosted endpoint (`mcp.onemap8.com`)

Target host: the box already serving `platform.onemap8.com` (Apache 2 → Onemap on `localhost:8082`).
The `mcp.onemap8.com` CNAME already resolves there; what is missing is a certificate for that name,
an Apache vhost, and the MCP service itself.

The MCP process listens on `127.0.0.1:3000` and is never exposed directly — Apache terminates TLS
and proxies to it.

> **The risk to manage:** `platform.onemap8.com` is live traffic. An Apache config error blocks the
> reload for *every* site on the host, not just the new one. That is why the certificate is obtained
> before any SSL vhost references it, and why `apache2ctl configtest` runs before every reload.

---

## 1. Install and build

```bash
sudo useradd --system --home /opt/onemap8-mcp --shell /usr/sbin/nologin onemap-mcp
sudo git clone <repo-url> /opt/onemap8-mcp
cd /opt/onemap8-mcp
sudo npm ci && sudo npm run build
sudo chown -R onemap-mcp:onemap-mcp /opt/onemap8-mcp
```

Node 20+ is required (`node -v`).

## 2. Configure

```bash
sudo -u onemap-mcp cp .env.example .env
sudo -u onemap-mcp chmod 600 .env
sudo -u onemap-mcp nano .env
```

For a multi-user deployment:

```ini
ONEMAP_URL=http://127.0.0.1:8082/api      # same host — no need to go out and back through TLS
ONEMAP_TOKEN=                             # leave empty; each request brings its own
ONEMAP_HTTP_PASSTHROUGH_AUTH=true         # testers are scoped to their own OneMap permissions
ONEMAP_READONLY=true                      # start here for the first testing round
ONEMAP_ALLOW_COMMANDS=false               # no vehicle commands from a shared endpoint
ONEMAP_ALLOW_DANGEROUS=false
PORT=3000
ONEMAP_ALLOWED_ORIGINS=                   # empty rejects browser cross-origin requests
```

`ONEMAP_TOKEN` empty plus passthrough means the service holds no credential of its own: a request
without a valid tester token can't reach any data. Note the process still validates config at boot,
so if you leave the token empty you must keep passthrough on.

## 3. Start the service

```bash
sudo cp deploy/onemap8-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now onemap8-mcp
sudo systemctl status onemap8-mcp
curl -s localhost:3000/health          # {"status":"ok",...}
```

## 4. Port-80 vhost, then the certificate

```bash
sudo cp deploy/apache-mcp.onemap8.com-step1-http.conf \
     /etc/apache2/sites-available/mcp.onemap8.com.conf
sudo a2ensite mcp.onemap8.com
sudo apache2ctl configtest && sudo systemctl reload apache2

sudo certbot certonly --webroot -w /var/www/html -d mcp.onemap8.com
sudo ls -l /etc/letsencrypt/live/mcp.onemap8.com/fullchain.pem
```

`certonly --webroot` obtains the certificate **without** letting certbot rewrite your Apache config,
so the working `platform.onemap8.com` vhost is left alone.

Do not continue until that `ls` shows the file.

## 5. SSL vhost

```bash
sudo a2enmod proxy proxy_http ssl rewrite headers env setenvif

sudo tee -a /etc/apache2/sites-available/mcp.onemap8.com.conf \
     < deploy/apache-mcp.onemap8.com-step2-ssl.conf

sudo apache2ctl configtest && sudo systemctl reload apache2
```

If `configtest` complains about overlapping defaults, see the note at the top of the step-2 file:
`platform.onemap8.com` uses `<VirtualHost _default_:443>` and this one uses `<VirtualHost *:443>`;
make the two forms agree, keeping the platform vhost first so it stays the fallback.

## 6. Verify from your laptop

```bash
curl -s https://mcp.onemap8.com/health

curl -s -X POST https://mcp.onemap8.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $YOUR_ONEMAP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300
```

Expect `{"status":"ok"…}` then a tool list. Checks worth making:

- **Certificate covers the new name:**
  `echo | openssl s_client -connect mcp.onemap8.com:443 -servername mcp.onemap8.com 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName`
- **platform.onemap8.com still works** — load the web UI. This is the one that matters.
- **A request with no token is refused**, and one with another user's token returns only that user's
  devices.

## Operating

```bash
sudo journalctl -u onemap8-mcp -f          # service logs
sudo systemctl restart onemap8-mcp         # after a rebuild
sudo tail -f /var/log/apache2/mcp.onemap8.com.error.log
```

To deploy a change: `git pull && npm ci && npm run build && sudo systemctl restart onemap8-mcp`.

Certificate renewal is handled by the existing certbot timer; `certonly --webroot` registers the
renewal automatically. Confirm with `sudo certbot renew --dry-run`.

### Rolling back

The endpoint is additive — nothing about `platform.onemap8.com` changes. To remove it entirely:

```bash
sudo a2dissite mcp.onemap8.com
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo systemctl disable --now onemap8-mcp
```

### Before opening it beyond internal testers

- There is no OAuth — anyone with a valid OneMap token can use the endpoint. That is the same bar as
  the API itself, but it means the endpoint is only as private as your tokens.
- No rate limiting. A misbehaving client can generate load on Onemap; consider `mod_ratelimit` or a
  `MaxRequestWorkers` review if usage grows.
- Every tester's token is a full-access credential for their account. Revoking one is done from that
  user's own Settings → Preferences, or by disabling the user.
