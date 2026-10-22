/**
 * src/remote/tunnel.ts against a fake `cloudflared` (a tiny Node script passed
 * as `bin`), so no network and no real tunnel. Covers: the URL handed back and
 * stop() ending the process, a missing binary (fails at once with the install
 * hint, no retries), cloudflared exiting early, Cloudflare's "failed to request
 * quick Tunnel" line, the 45 s start timeout, and the retry loop giving up after
 * three attempts. Retry back-off and the start timeout run on mocked timers.
 */

import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installHint, startQuickTunnel } from '../src/remote/tunnel';

const POSIX = process.platform !== 'win32';

const fakeDirs: string[] = [];

// A failed test must not leave a fake cloudflared running: its open pipes would
// keep this test file from ever exiting.
after(() => {
  for (const dir of fakeDirs) {
    for (const file of readdirSync(dir)) {
      const pid = Number(/^args-(\d+)$/.exec(file)?.[1]);
      if (pid) try { process.kill(pid); } catch { /* already gone */ }
    }
  }
});

/** Write an executable fake cloudflared that runs `body` (Node source). */
function fakeCloudflared(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-cloudflared-'));
  fakeDirs.push(dir);
  const bin = join(dir, 'cloudflared');
  writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `const dir = ${JSON.stringify(dir)};\n` +
      `fs.writeFileSync(require('node:path').join(dir, 'args-' + process.pid), JSON.stringify(process.argv.slice(2)));\n` +
      body,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

const TUNNEL_LINE =
  "INF |  https://brave-otter-sun-heater.trycloudflare.com                    |\n";

/** Resolve after real I/O turns (setImmediate and performance are not mocked
 *  here). Wall-clock bounded: a busy machine can take a while to start Node. */
async function untilTrue(pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('condition never became true');
}

test('installHint names a way to install cloudflared on this platform', () => {
  const hint = installHint();
  if (process.platform === 'darwin') assert.equal(hint, 'Install it with: brew install cloudflared');
  else if (process.platform === 'win32') assert.match(hint, /winget/);
  else assert.match(hint, /developers\.cloudflare\.com/);
});

test('a reported URL resolves the tunnel; stop() ends cloudflared and onExit fires', { skip: !POSIX }, async () => {
  const { bin, dir } = fakeCloudflared(
    `process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n');\n` +
      `setTimeout(() => process.stderr.write(${JSON.stringify(TUNNEL_LINE)}), 20);\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const logs: string[] = [];
  let exited: { code: number | null } | null = null;
  const tunnel = await startQuickTunnel({
    localPort: 41234,
    bin,
    log: (m) => logs.push(m),
    onExit: (code) => {
      exited = { code };
    },
  });
  assert.equal(tunnel.url, 'https://brave-otter-sun-heater.trycloudflare.com');
  const argFile = require('node:fs').readdirSync(dir).find((f: string) => f.startsWith('args-'));
  assert.deepEqual(JSON.parse(require('node:fs').readFileSync(join(dir, argFile), 'utf8')), [
    'tunnel',
    '--no-autoupdate',
    '--url',
    'http://127.0.0.1:41234',
  ]);
  tunnel.stop();
  await untilTrue(() => exited !== null);
  assert.deepEqual(exited, { code: null }, 'killed by a signal: no exit code');
  assert.deepEqual(logs, []);
});

test('the URL can arrive on stdout too', { skip: !POSIX }, async () => {
  const { bin } = fakeCloudflared(`process.stdout.write(${JSON.stringify(TUNNEL_LINE)});\nsetInterval(() => {}, 1000);\n`);
  const tunnel = await startQuickTunnel({ localPort: 1, bin, log: () => {} });
  assert.equal(tunnel.url, 'https://brave-otter-sun-heater.trycloudflare.com');
  tunnel.stop();
});

test('a missing cloudflared fails at once with the install hint, without retrying', async () => {
  const logs: string[] = [];
  const started = Date.now();
  await assert.rejects(
    startQuickTunnel({ localPort: 1, bin: join(tmpdir(), 'definitely-not-cloudflared-xyz'), log: (m) => logs.push(m) }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, `Couldn't start: --tunnel needs cloudflared, which is not installed. ${installHint()}`);
      return true;
    },
  );
  assert.deepEqual(logs, [], 'no retry was attempted');
  assert.ok(Date.now() - started < 2_000);
});

/** Node 20.11+ takes { apis }; Node 18 and early 20 take the bare list. */
function enableFakeTimeouts(t: TestContext): void {
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
  } catch {
    (t.mock.timers.enable as unknown as (apis: string[]) => void)(['setTimeout']);
  }
}

function mockTimersRetrying(t: TestContext, logs: string[]): (m: string) => void {
  enableFakeTimeouts(t);
  return (m: string) => {
    logs.push(m);
    const attempt = Number(/tunnel attempt (\d+) failed/.exec(m)?.[1]);
    // Skip the back-off (3 s, then 6 s) once the retry has been scheduled.
    if (attempt) setImmediate(() => t.mock.timers.tick(3_000 * attempt));
  };
}

test('cloudflared exiting before a URL is retried, then reported after three attempts', { skip: !POSIX }, async (t) => {
  const { bin, dir } = fakeCloudflared(`process.exit(3);\n`);
  const logs: string[] = [];
  const log = mockTimersRetrying(t, logs);
  await assert.rejects(startQuickTunnel({ localPort: 1, bin, log }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(
      err.message,
      "Couldn't start: no tunnel after 3 tries. Couldn't start: cloudflared exited (code 3) before the tunnel came up.. " +
        "Cloudflare's free quick tunnels are sometimes down; try again in a few minutes.",
    );
    return true;
  });
  assert.equal(logs.length, 2, 'two retries are announced');
  assert.match(logs[0], /^tunnel attempt 1 failed: Couldn't start: cloudflared exited \(code 3\)/);
  assert.match(logs[1], /^tunnel attempt 2 failed/);
  assert.equal(require('node:fs').readdirSync(dir).filter((f: string) => f.startsWith('args-')).length, 3, 'three processes');
});

test("Cloudflare's quick-tunnel failure line ends the attempt and is quoted", { skip: !POSIX }, async (t) => {
  const { bin } = fakeCloudflared(
    `process.stderr.write('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded\\nmore\\n');\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const logs: string[] = [];
  const log = mockTimersRetrying(t, logs);
  await assert.rejects(startQuickTunnel({ localPort: 1, bin, log }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(
      err.message,
      /no tunnel after 3 tries\. Cloudflare's quick-tunnel service did not answer \(failed to request quick Tunnel: Post "https:\/\/api\.trycloudflare\.com\/tunnel": context deadline exceeded\)/,
    );
    assert.ok(!/api\.trycloudflare\.com\/tunnel".*more/.test(err.message), 'only the failing line is quoted');
    return true;
  });
  assert.equal(logs.length, 2);
});

test('no URL within the start timeout kills cloudflared and the attempt fails', { skip: !POSIX }, async (t) => {
  const { bin, dir } = fakeCloudflared(
    `fs.writeFileSync(require('node:path').join(dir, 'ready-' + process.pid), '');\n` +
      `process.stderr.write('INF still connecting\\n');\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  enableFakeTimeouts(t);
  const readyCount = (): number => require('node:fs').readdirSync(dir).filter((f: string) => f.startsWith('ready-')).length;
  const logs: string[] = [];
  let attempts = 0;
  const done = startQuickTunnel({
    localPort: 1,
    bin,
    log: (m) => {
      logs.push(m);
      const attempt = Number(/tunnel attempt (\d+) failed/.exec(m)?.[1]);
      if (attempt) setImmediate(() => t.mock.timers.tick(3_000 * attempt));
    },
  });
  const outcome = done.then(
    () => 'resolved',
    (err: Error) => err.message,
  );
  // Each attempt: wait until the fake is running, then jump past 45 s.
  for (attempts = 1; attempts <= 3; attempts++) {
    await untilTrue(() => readyCount() >= attempts);
    t.mock.timers.tick(45_000);
  }
  const message = await outcome;
  assert.match(message, /no tunnel after 3 tries\. Couldn't start: cloudflared did not report a tunnel URL in time\. Check your internet connection\./);
  assert.match(logs[0], /did not report a tunnel URL in time/);
  assert.ok(existsSync(dir));
});
