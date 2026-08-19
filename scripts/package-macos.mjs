#!/usr/bin/env node
/**
 * Builds a self-contained macOS zip for a non-technical recipient.
 *
 *   npm run package
 *
 * The zip carries the compiled server plus production dependencies only, so
 * the recipient never runs `npm install` or `npm run build` — they double-click
 * install.command and answer one question.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packaging', 'build');
const NAME = 'OneMap8-Assistant';
const STAGE = join(OUT, NAME);
const ZIP = join(OUT, `${NAME}.zip`);

const run = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', encoding: 'utf8' });

console.log('\nBuilding the macOS installer package\n');

console.log('▸ Compiling');
run('npm', ['run', 'build']);

console.log('▸ Staging');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

cpSync(join(ROOT, 'dist'), join(STAGE, 'dist'), { recursive: true });
cpSync(join(ROOT, 'package.json'), join(STAGE, 'package.json'));
cpSync(join(ROOT, 'package-lock.json'), join(STAGE, 'package-lock.json'));

console.log('▸ Installing production dependencies (dev tooling excluded)');
run('npm', ['ci', '--omit=dev', '--silent'], STAGE);

// The lockfile and manifest are only needed for that install; leaving them
// invites the recipient to run npm commands they do not need.
rmSync(join(STAGE, 'package-lock.json'), { force: true });

console.log('▸ Adding the installer');
const installer = join(STAGE, 'install.command');
// Bake the operator's own server in as the default, so their recipient does
// not have to type a URL. Public builds leave the placeholder, which makes the
// installer prompt for the address instead.
const defaultUrl = process.env.ONEMAP_DEFAULT_URL ?? '__ONEMAP_DEFAULT_URL__';
writeFileSync(
  installer,
  readFileSync(join(ROOT, 'packaging', 'install.command'), 'utf8').replaceAll('__ONEMAP_DEFAULT_URL__', defaultUrl),
);
chmodSync(installer, 0o755);
console.log(
  defaultUrl === '__ONEMAP_DEFAULT_URL__'
    ? '  (no ONEMAP_DEFAULT_URL set — the installer will ask the recipient for the server address)'
    : `  default server: ${defaultUrl}`,
);

writeFileSync(
  join(STAGE, 'READ ME FIRST.txt'),
  `OneMap8 assistant — how to install
====================================

1. Double-click "install.command".

   macOS will probably refuse the first time, because the file was
   downloaded from the internet. If it does:

     - Right-click (or Control-click) install.command
     - Choose "Open"
     - Click "Open" in the dialog that appears

   You only have to do that once.

2. Follow the instructions in the window that opens. It will ask you
   for a OneMap8 token and tell you exactly where to find it.

3. When it finishes, quit Claude Desktop completely (Claude > Quit)
   and open it again.

Then ask Claude: "which of my vehicles are online right now?"

Notes
-----
- This is read-only. It cannot change anything in OneMap8, and it
  cannot send commands to vehicles.
- You will only see the vehicles your own OneMap8 account can see.
- Keep your token private. It works like a password.

If something goes wrong, send a screenshot of the window to whoever
gave you this file.
`,
);

console.log('▸ Zipping');
mkdirSync(OUT, { recursive: true });
// ditto preserves the executable bit on install.command; `zip` on macOS can
// lose it, which would leave the recipient with a file that will not open.
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', STAGE, ZIP], OUT);

const mb = (statSync(ZIP).size / 1024 / 1024).toFixed(1);
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

console.log(`
Done.

  ${ZIP}
  ${mb} MB · v${version}

Send that single file. The recipient unzips it, right-clicks
install.command, and chooses Open.
`);

if (!existsSync(ZIP)) {
  console.error('Expected zip was not produced.');
  process.exit(1);
}
