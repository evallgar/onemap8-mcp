#!/bin/bash
#
# Double-clickable installer for non-technical users (macOS).
#
# Copies the server to a permanent location, collects the user's OneMap token,
# verifies it against the live server, and writes the Claude Desktop config so
# the user never has to open a JSON file or type a command.

set -uo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so the installer can be exercised against throwaway paths
# without touching a real Claude Desktop configuration.
INSTALL_DIR="${ONEMAP_INSTALL_DIR:-$HOME/Library/Application Support/OneMap8 MCP}"
CLAUDE_CONFIG="${ONEMAP_CLAUDE_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
# Replaced at package time by scripts/package-macos.mjs (ONEMAP_DEFAULT_URL).
DEFAULT_URL="__ONEMAP_DEFAULT_URL__"
NONINTERACTIVE="${ONEMAP_NONINTERACTIVE:-}"

banner() { printf '\n%s\n' "${BOLD}$1${OFF}"; }
ok()     { printf '%s %s\n' "${GREEN}✓${OFF}" "$1"; }
warn()   { printf '%s %s\n' "${YELLOW}!${OFF}" "$1"; }

# Keep the Terminal window open on failure so the user can read the reason.
die() {
  printf '\n%s %s\n\n' "${RED}✗${OFF}" "$1"
  if [ -z "$NONINTERACTIVE" ]; then
    printf '%s\n' "${DIM}Press Return to close this window.${OFF}"
    read -r _ || true
  fi
  exit 1
}

clear
cat <<BANNER
${BOLD}OneMap8 assistant — setup${OFF}

This connects Claude Desktop to OneMap8 so you can ask questions about the
fleet in plain language.

It takes about two minutes. You will need:
  • Claude Desktop installed
  • A OneMap8 token (this will tell you how to get one)

BANNER

if [ -z "$NONINTERACTIVE" ]; then
  printf '%s' "${DIM}Press Return to begin.${OFF}"
  read -r _ || true
fi

# --- 1. Node -----------------------------------------------------------------

banner "Step 1 of 4 — checking requirements"

if ! command -v node >/dev/null 2>&1; then
  cat <<NODE

${YELLOW}Node.js is not installed.${OFF} It is a free tool this connector runs on.

  1. The download page will open in your browser.
  2. Download the button marked ${BOLD}LTS${OFF}.
  3. Open the downloaded file and click through the installer.
  4. Come back and double-click this installer again.

NODE
  printf '%s' "${DIM}Press Return to open the download page.${OFF}"
  read -r _ || true
  open "https://nodejs.org/en/download"
  exit 0
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js $(node -v) is too old — version 20 or newer is needed. Install the LTS release from nodejs.org and run this again."
fi
ok "Node.js $(node -v)"

if [ ! -d "$HOME/Library/Application Support/Claude" ]; then
  warn "Claude Desktop does not appear to be installed yet."
  warn "Install it from https://claude.ai/download, open it once, then run this again."
  printf '\n%s' "${DIM}Press Return to continue anyway, or close this window.${OFF}"
  read -r _ || true
fi

# --- 2. Copy to a permanent home --------------------------------------------

banner "Step 2 of 4 — installing"

# Installing outside the download folder means the connector keeps working
# after the downloaded folder is moved to the Trash.
mkdir -p "$INSTALL_DIR" || die "Could not create $INSTALL_DIR"
rsync -a --delete \
  --exclude '.env' \
  --exclude 'install.command' \
  "$SOURCE_DIR"/ "$INSTALL_DIR"/ 2>/dev/null \
  || cp -R "$SOURCE_DIR"/* "$INSTALL_DIR"/ \
  || die "Could not copy files into $INSTALL_DIR"

[ -f "$INSTALL_DIR/dist/stdio.js" ] || die "The download looks incomplete — dist/stdio.js is missing. Ask for a fresh copy."
ok "Installed to $INSTALL_DIR"

# --- 3. Token ----------------------------------------------------------------

banner "Step 3 of 4 — connecting your OneMap8 account"

cat <<TOKEN

Get your personal token:

  1. Open OneMap8 in your browser and sign in.
  2. Go to ${BOLD}Settings → Preferences${OFF}.
  3. Choose an ${BOLD}expiration date${OFF} — pick one several months away.
  4. Click ${BOLD}Generate${OFF}, then copy the token.

${DIM}The token is tied to your own account. You will only see the vehicles you
already have access to. Treat it like a password — do not share it.${OFF}

TOKEN

printf 'Paste your token here %s: ' "${DIM}(it stays hidden)${OFF}"
IFS= read -rs ONEMAP_TOKEN
printf '\n'
[ -n "${ONEMAP_TOKEN:-}" ] || die "No token was entered. Run the installer again."

if [ "$DEFAULT_URL" = "__ONEMAP_DEFAULT_URL__" ]; then
  printf 'OneMap8 address %s: ' "${DIM}e.g. https://tracking.example.com/api${OFF}"
  IFS= read -r ONEMAP_URL
  [ -n "${ONEMAP_URL:-}" ] || die "No address was entered. Run the installer again."
else
  printf 'OneMap8 address %s: ' "${DIM}[$DEFAULT_URL]${OFF}"
  IFS= read -r ONEMAP_URL
  ONEMAP_URL="${ONEMAP_URL:-$DEFAULT_URL}"
fi

banner "Checking that it works"

VERIFY="$(
  ONEMAP_URL="$ONEMAP_URL" ONEMAP_TOKEN="$ONEMAP_TOKEN" \
  node -e '
    const url = process.env.ONEMAP_URL.replace(/\/+$/, "");
    const base = url.endsWith("/api") ? url : url + "/api";
    fetch(base + "/devices", { headers: { Authorization: "Bearer " + process.env.ONEMAP_TOKEN } })
      .then(async (response) => {
        if (response.ok) {
          const devices = await response.json();
          const online = devices.filter((d) => d.status === "online").length;
          console.log(`OK|${devices.length}|${online}`);
          return;
        }
        const body = await response.text();
        const badToken =
          response.status === 401 ||
          (response.status === 400 && /CryptoManager|NegativeArraySize|ArrayIndexOutOfBounds/i.test(body));
        console.log(badToken ? "BADTOKEN|" : `HTTP|${response.status}`);
      })
      .catch((error) => console.log("NETWORK|" + error.message));
  ' 2>/dev/null
)"

case "${VERIFY%%|*}" in
  OK)
    TOTAL="$(echo "$VERIFY" | cut -d'|' -f2)"
    ONLINE="$(echo "$VERIFY" | cut -d'|' -f3)"
    ok "Connected — you can see $TOTAL vehicles, $ONLINE online right now."
    ;;
  BADTOKEN)
    die "That token was not accepted. Copy it again from Settings → Preferences — make sure you get the whole thing — then run this installer again."
    ;;
  NETWORK)
    die "Could not reach ${ONEMAP_URL}. Check your internet connection and that the address is right, then try again."
    ;;
  *)
    die "The OneMap8 server returned an unexpected response (${VERIFY}). Send this message to whoever gave you this installer."
    ;;
esac

umask 077
cat > "$INSTALL_DIR/.env" <<ENV
ONEMAP_URL=$ONEMAP_URL
ONEMAP_TOKEN=$ONEMAP_TOKEN
ONEMAP_READONLY=true
ONEMAP_ALLOW_COMMANDS=false
ONEMAP_ALLOW_DANGEROUS=false
ONEMAP_MAX_ROWS=200
ONEMAP_TIMEOUT_MS=30000
ENV
chmod 600 "$INSTALL_DIR/.env"
unset ONEMAP_TOKEN
ok "Saved your settings (read-only mode — nothing can be changed in OneMap8)"

# --- 4. Claude Desktop config ------------------------------------------------

banner "Step 4 of 4 — setting up Claude Desktop"

mkdir -p "$(dirname "$CLAUDE_CONFIG")"

# Merge rather than overwrite: this user may already have other connectors
# configured, and clobbering them would be a nasty surprise.
INSTALL_DIR="$INSTALL_DIR" CLAUDE_CONFIG="$CLAUDE_CONFIG" node -e '
  const fs = require("fs");
  const path = process.env.CLAUDE_CONFIG;
  const entry = {
    command: "node",
    args: [require("path").join(process.env.INSTALL_DIR, "dist", "stdio.js")],
  };

  let config = {};
  if (fs.existsSync(path)) {
    const raw = fs.readFileSync(path, "utf8");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      // Never destroy a config we cannot parse — keep a copy and start clean.
      const rescue = path + ".unreadable-" + Date.now();
      fs.copyFileSync(path, rescue);
      console.error("UNPARSEABLE:" + rescue);
      config = {};
    }
    fs.copyFileSync(path, path + ".backup-" + Date.now());
  }

  config.mcpServers = { ...(config.mcpServers || {}), onemap8: entry };
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");

  const others = Object.keys(config.mcpServers).filter((k) => k !== "onemap8");
  console.log("MERGED:" + others.length);
' > /tmp/onemap8-config-result 2>/tmp/onemap8-config-error

if [ $? -ne 0 ]; then
  die "Could not update the Claude Desktop settings file. $(cat /tmp/onemap8-config-error 2>/dev/null)"
fi

if grep -q "UNPARSEABLE" /tmp/onemap8-config-error 2>/dev/null; then
  warn "Your existing Claude settings file could not be read, so a copy was saved and a fresh one written."
fi

OTHERS="$(cut -d: -f2 /tmp/onemap8-config-result 2>/dev/null || echo 0)"
rm -f /tmp/onemap8-config-result /tmp/onemap8-config-error
if [ "${OTHERS:-0}" -gt 0 ] 2>/dev/null; then
  ok "Claude Desktop configured (your $OTHERS existing connector(s) were left alone)"
else
  ok "Claude Desktop configured"
fi

# --- Done --------------------------------------------------------------------

cat <<DONE

${GREEN}${BOLD}All set.${OFF}

  ${BOLD}1.${OFF} Quit Claude Desktop completely — ${BOLD}Claude → Quit${OFF}, or ⌘Q.
     ${DIM}Closing the window is not enough; it must fully quit.${OFF}
  ${BOLD}2.${OFF} Open Claude Desktop again.
  ${BOLD}3.${OFF} Ask it: ${BOLD}"which of my vehicles are online right now?"${OFF}

Other things to try:
  ${DIM}Where is <vehicle name>?
  How far did <vehicle name> drive last week?
  Which vehicles had alarms overnight?${OFF}

If Claude says it cannot find any tools, make sure you fully quit and
reopened the app.

DONE

if [ -z "$NONINTERACTIVE" ]; then
  printf '%s' "${DIM}Press Return to close this window.${OFF}"
  read -r _ || true
fi
