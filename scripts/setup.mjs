#!/usr/bin/env node
/**
 * One-command onboarding for a new tester.
 *
 *   npm run setup
 *
 * Builds the server, collects the tester's own OneMap credentials, verifies
 * them against the live API, writes `.env`, and prints the exact client config
 * to paste. Everything stays on the tester's machine — no token is ever sent
 * anywhere except to the OneMap server it belongs to.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const DEFAULT_URL = process.env.ONEMAP_DEFAULT_URL || 'https://tracking.example.com/api';

const style = {
  bold: (s) => `[1m${s}[0m`,
  dim: (s) => `[2m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question, fallback = '') =>
  new Promise((done) => {
    rl.question(fallback ? `${question} ${style.dim(`[${fallback}]`)}: ` : `${question}: `, (answer) =>
      done(answer.trim() || fallback),
    );
  });

/**
 * Reads a secret without echoing it. The token is a full-access credential for
 * the tester's account, so it must not end up visible on screen, in a
 * screen-share, or in shell history.
 */
const askSecret = (question) =>
  new Promise((done) => {
    const output = rl.output;
    let captured = '';
    const onKey = (char) => {
      const key = char.toString('utf8');
      if (key === '\r' || key === '\n' || key === '') return;
      if (key === '') captured = captured.slice(0, -1);
      else if (key === '') {
        output.write('\n');
        process.exit(130);
      } else captured += key;
    };

    output.write(`${question}: `);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', onKey);

    rl.question('', () => {
      process.stdin.off('data', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      output.write('\n');
      done(captured.trim());
    });
  });

function step(message) {
  console.log(`\n${style.bold(`▸ ${message}`)}`);
}

function fail(message) {
  console.error(`\n${style.red('✗')} ${message}`);
  process.exit(1);
}

async function main() {
  console.log(style.bold('\nOneMap8 MCP — tester setup\n'));

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) fail(`Node 20 or newer is required (this is ${process.versions.node}).`);

  step('Installing dependencies and building');
  execFileSync('npm', ['install', '--silent'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });

  step('Connection details');
  if (existsSync(ENV_PATH)) {
    const keep = await ask('A .env already exists. Overwrite it? (y/N)', 'N');
    if (!/^y/i.test(keep)) {
      console.log(style.dim('Keeping the existing .env. Skipping to verification.'));
      rl.close();
      return verifyAndPrint();
    }
  }

  const url = await ask('OneMap API URL', DEFAULT_URL);
  console.log(
    style.dim(
      '\nGenerate a personal API token in OneMap: Settings → Preferences → pick an expiration → generate → copy.\n' +
        'It is tied to your own account, so you will only see the vehicles you already have access to.\n' +
        'Input is hidden below.',
    ),
  );
  const token = await askSecret('OneMap API token');
  if (!token) fail('No token entered.');

  const template = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const contents = template
    .replace(/^ONEMAP_URL=.*$/m, `ONEMAP_URL=${url}`)
    .replace(/^ONEMAP_TOKEN=.*$/m, `ONEMAP_TOKEN=${token}`)
    .replace(/^ONEMAP_READONLY=.*$/m, 'ONEMAP_READONLY=true')
    .replace(/^ONEMAP_ALLOW_COMMANDS=.*$/m, 'ONEMAP_ALLOW_COMMANDS=false');

  writeFileSync(ENV_PATH, contents, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  console.log(`${style.green('✓')} Wrote ${ENV_PATH} (permissions 600, owner-only)`);
  console.log(
    style.dim('  Starting safely: writes and device commands are disabled. See the guardrails table in README.md.'),
  );

  rl.close();
  await verifyAndPrint();
}

async function verifyAndPrint() {
  step('Verifying against the live server');

  const { loadEnvFile, configFromEnv } = await import(join(ROOT, 'dist', 'config.js'));
  loadEnvFile();
  const config = configFromEnv();

  const headers = { Authorization: `Bearer ${config.token}` };
  const devices = await fetch(`${config.baseUrl}/devices`, { headers }).catch((error) => {
    fail(`Could not reach ${config.baseUrl}: ${error.message}`);
  });

  if (!devices.ok) {
    // A truncated token fails to decode server-side and comes back as a 400
    // with a Java stack trace, not a 401 — both mean "fix your token".
    const body = await devices.text().catch(() => '');
    const badToken =
      devices.status === 401 ||
      (devices.status === 400 && /CryptoManager|NegativeArraySize|ArrayIndexOutOfBounds/i.test(body));

    fail(
      badToken
        ? 'That token was rejected. Copy it again from Settings → Preferences — make sure you got the\n' +
            '  whole string — then re-run `npm run setup`.'
        : `The server answered ${devices.status} for GET /devices.\n  ${body.slice(0, 200)}`,
    );
  }

  const list = await devices.json();
  const online = list.filter((device) => device.status === 'online').length;
  console.log(`${style.green('✓')} Connected — ${list.length} device(s) visible to you, ${online} online.`);

  const config_json = JSON.stringify(
    { mcpServers: { onemap8: { command: 'node', args: [join(ROOT, 'dist', 'stdio.js')] } } },
    null,
    2,
  );

  console.log(`\n${style.bold('Next: add it to your client.')}`);
  console.log(`
${style.bold('Claude Code')} — save this as ${style.bold('.mcp.json')} in the project you work in,
then restart Claude Code and run ${style.bold('claude mcp list')} to confirm it says "✓ Connected":

${config_json}

${style.bold('Claude Desktop')} — merge the same "mcpServers" block into:
  ${style.dim('~/Library/Application Support/Claude/claude_desktop_config.json')}   (macOS)
  ${style.dim(String.raw`%APPDATA%\Claude\claude_desktop_config.json`)}                         (Windows)
then quit and reopen the app.

${style.bold('Try it with:')} "which of my vehicles are online right now?"
`);

  console.log(style.yellow('Your token lives in .env and is git-ignored. Do not paste it into chat or a shared doc.\n'));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
