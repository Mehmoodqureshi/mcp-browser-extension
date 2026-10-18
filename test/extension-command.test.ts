/**
 * `mcp-browser-extension extension doctor|repair` (src/extension-command.ts):
 * argument handling, the human and --json renderings, and the exit code. Runs
 * in-process against fixture browser directories passed with --user-data-dir,
 * so nothing reads or touches a real browser profile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExtensionCommand } from '../src/extension-command';
import { STORE_EXTENSION_ID } from '../shared/protocol';

const STALE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const storeKey = readFileSync(join(__dirname, '..', '..', 'extension', 'store-public-key.txt'), 'utf8').trim();

interface Run {
  handled: boolean;
  out: string;
  err: string;
  exitCode: number | undefined;
}

/** Run the command with stdout/stderr captured and process.exitCode restored. */
function run(argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => (out.push(String(s)), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => (err.push(String(s)), true);
  let handled: boolean;
  let exitCode: number | undefined;
  try {
    handled = runExtensionCommand(argv);
    exitCode = process.exitCode as number | undefined;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = prevExit;
  }
  return { handled, out: out.join(''), err: err.join(''), exitCode };
}

/** A browser dir with one profile holding the duplicate-ID conflict. */
function conflictFixture(): { root: string; profile: string; prefs: string; extension: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), 'cmcp-extcmd-'));
  const root = join(base, 'browser');
  const profile = join(root, 'Default');
  const extension = join(base, 'extension');
  mkdirSync(profile, { recursive: true });
  mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ name: 'MCP Browser Extension', version: '1.0', key: storeKey }));
  const prefs = join(profile, 'Secure Preferences');
  writeFileSync(
    prefs,
    JSON.stringify({
      extensions: {
        settings: {
          [STORE_EXTENSION_ID]: { path: extension, location: 4 },
          [STALE_ID]: { path: extension, location: 4, disable_reasons: [4] },
        },
      },
    }),
  );
  return { root, profile, prefs, extension, base };
}

/** A browser dir whose only profile has a clean Store install. */
function cleanFixture(): { root: string; profile: string } {
  const base = mkdtempSync(join(tmpdir(), 'cmcp-extcmd-clean-'));
  const root = join(base, 'browser');
  const profile = join(root, 'Profile 1');
  const ext = join(profile, 'Extensions', STORE_EXTENSION_ID, '1.0_0');
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ name: 'MCP Browser Extension', version: '1.0' }));
  writeFileSync(
    join(profile, 'Preferences'),
    JSON.stringify({ extensions: { settings: { [STORE_EXTENSION_ID]: { path: `${STORE_EXTENSION_ID}/1.0_0`, location: 1, from_webstore: true } } } }),
  );
  return { root, profile };
}

test('only the extension subcommand is handled', () => {
  const r = run(['tasks', 'list']);
  assert.equal(r.handled, false);
  assert.equal(r.out, '');
  assert.equal(run([]).handled, false);
});

test('no subcommand, --help or help prints the usage', () => {
  for (const argv of [['extension'], ['extension', '--help'], ['extension', 'help']]) {
    const r = run(argv);
    assert.equal(r.handled, true);
    assert.match(r.out, /^mcp-browser-extension extension — diagnose an extension missing after a browser restart\./);
    assert.match(r.out, /extension repair \[--apply\]/);
    assert.equal(r.exitCode, undefined);
  }
});

test('unknown subcommands and options fail with exit code 1 and a message', () => {
  const unknown = run(['extension', 'reinstall']);
  assert.equal(unknown.handled, true);
  assert.equal(unknown.err, 'extension reinstall: Unknown extension command: reinstall\n');
  assert.equal(unknown.exitCode, 1);

  const badOpt = run(['extension', 'doctor', '--force']);
  assert.equal(badOpt.err, 'extension doctor: Unknown option: --force\n');
  assert.equal(badOpt.exitCode, 1);

  const applyOnDoctor = run(['extension', 'doctor', '--apply']);
  assert.equal(applyOnDoctor.err, 'extension doctor: Unknown option: --apply\n', '--apply belongs to repair only');

  for (const flag of ['--user-data-dir', '--data-dir']) {
    const missing = run(['extension', 'repair', flag]);
    assert.equal(missing.err, `extension repair: ${flag} needs a directory\n`);
    const flagged = run(['extension', 'repair', flag, '--json']);
    assert.equal(flagged.err, `extension repair: ${flag} needs a directory\n`, 'a following flag is not a directory');
    assert.equal(flagged.exitCode, 1);
  }
});

test('doctor prints each registration and the confirmed conflict', () => {
  const f = conflictFixture();
  const before = readFileSync(f.prefs, 'utf8');
  const r = run(['extension', 'doctor', '--user-data-dir', f.root]);
  assert.equal(r.exitCode, undefined);
  assert.equal(r.err, '');
  const lines = r.out.split('\n');
  assert.equal(lines[0], f.profile);
  assert.ok(lines.includes(`  unpacked: ${STORE_EXTENSION_ID}`));
  assert.ok(lines.includes(`  unpacked: ${STALE_ID}`));
  assert.ok(lines.includes(`    ${f.extension}`));
  assert.ok(lines.includes(`  ${STALE_ID}: saved ID differs from the manifest ID ${STORE_EXTENSION_ID}`));
  assert.ok(lines.includes(`  ${STALE_ID}: Chrome disable reason(s): 4`));
  assert.ok(lines.includes('  Confirmed stale unpacked registration blocks the current extension folder at browser startup.'));
  assert.equal(readFileSync(f.prefs, 'utf8'), before, 'doctor is read-only');
});

test('doctor --json emits the scan object', () => {
  const f = conflictFixture();
  const r = run(['extension', 'doctor', '--json', '--user-data-dir', f.root]);
  const scan = JSON.parse(r.out);
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.profiles.length, 1);
  assert.deepEqual(scan.profiles[0].staleIds, [STALE_ID]);
});

test('doctor on a healthy profile says so; on an empty directory explains what it looked for', () => {
  const clean = cleanFixture();
  const ok = run(['extension', 'doctor', '--user-data-dir', clean.root]);
  assert.match(ok.out, /web-store: [a-z]{32}\n/);
  assert.match(ok.out, /  No registration or file problem found\.\n$/);

  const empty = mkdtempSync(join(tmpdir(), 'cmcp-extcmd-empty-'));
  const none = run(['extension', 'doctor', '--user-data-dir', empty]);
  assert.equal(
    none.out,
    'No matching extension registrations found in the inspected browser directories. Use --user-data-dir for a custom browser directory.\n',
  );
  assert.equal(none.exitCode, undefined);
});

test('doctor reports unreadable preferences on stderr with exit code 1', () => {
  const base = mkdtempSync(join(tmpdir(), 'cmcp-extcmd-bad-'));
  const profile = join(base, 'Default');
  mkdirSync(profile);
  writeFileSync(join(profile, 'Preferences'), '{not json');
  const r = run(['extension', 'doctor', '--user-data-dir', base]);
  assert.equal(r.err, `Cannot parse browser preferences: ${join(profile, 'Preferences')}\n`);
  assert.equal(r.exitCode, 1);
  const j = run(['extension', 'doctor', '--json', '--user-data-dir', base]);
  assert.equal(JSON.parse(j.out).errors.length, 1);
  assert.equal(j.exitCode, 1);
});

test('repair previews by default and changes nothing', () => {
  const f = conflictFixture();
  const before = readFileSync(f.prefs, 'utf8');
  const backups = mkdtempSync(join(tmpdir(), 'cmcp-extcmd-data-'));
  const r = run(['extension', 'repair', '--user-data-dir', f.root, '--data-dir', backups]);
  assert.match(r.out, /Preview: 1 obsolete registration\(s\) can be removed\. Fully quit Chromium browsers, then repeat with --apply\.\n$/);
  assert.equal(readFileSync(f.prefs, 'utf8'), before);
  assert.deepEqual(readdirSync(backups), [], 'no backup made by a preview');

  const json = run(['extension', 'repair', '--json', '--user-data-dir', f.root, '--data-dir', backups]);
  const result = JSON.parse(json.out);
  assert.equal(result.applied, false);
  assert.deepEqual(result.removed, []);
});

test('repair with nothing stale says nothing changed; parse errors give exit code 1', () => {
  const clean = cleanFixture();
  const r = run(['extension', 'repair', '--user-data-dir', clean.root]);
  assert.match(r.out, /No confirmed stale-ID conflict to repair\. Nothing changed\.\n$/);
  assert.equal(r.exitCode, undefined);

  const base = mkdtempSync(join(tmpdir(), 'cmcp-extcmd-bad2-'));
  mkdirSync(join(base, 'Default'));
  writeFileSync(join(base, 'Default', 'Secure Preferences'), '[]');
  const bad = run(['extension', 'repair', '--user-data-dir', base]);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.err, /Cannot parse browser preferences/);
});

test('repair --apply either removes the stale record with a backup, or refuses while a browser runs', () => {
  const f = conflictFixture();
  const before = readFileSync(f.prefs, 'utf8');
  const dataDir = join(f.base, 'data');
  const r = run(['extension', 'repair', '--apply', '--user-data-dir', f.root, '--data-dir', dataDir]);
  if (r.exitCode === 1) {
    // A Chromium browser is open on this machine (or ps failed): fail closed.
    assert.match(r.err, /^extension repair: (Fully quit Chrome|Cannot verify that browsers are closed)/);
    assert.equal(readFileSync(f.prefs, 'utf8'), before, 'nothing changed');
  } else {
    assert.match(r.out, /Removed 1 obsolete registration\(s\)\. Backup: .*extension-repair-backups/);
    assert.match(r.out, /Reopen your browser and check chrome:\/\/extensions\.\n$/);
    const after = JSON.parse(readFileSync(f.prefs, 'utf8'));
    assert.equal(after.extensions.settings[STALE_ID], undefined);
    assert.ok(after.extensions.settings[STORE_EXTENSION_ID]);
    assert.ok(existsSync(join(dataDir, 'extension-repair-backups')));
  }
});
