/**
 * src/cli.ts end to end, as a user (or an MCP host) runs it: `node dist/src/cli.js`.
 *
 * cli.ts exports nothing and runs main() on import, so every case spawns it.
 * Isolation, so a test run never touches the person's real setup:
 *   - HOME, the data dir and the unpacked-extension folder all point into a
 *     fresh temp dir; telemetry, auto-update and native-host registration are off.
 *   - Server-mode cases first start a hub BridgeServer in this process on a
 *     free port and give the child the same token, so the child joins it as a
 *     PEER. Only a hub publishes pairing files (into the package's
 *     extension-dist), so the child never writes there. Every child is killed
 *     before the hub stops, so it can never be promoted to hub by failover.
 *   - --tunnel cases put a fake (or no) cloudflared first on PATH.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BridgeServer } from '../src/bridge/server';
import { ensureWorkspace } from '../src/bridge/datadir';
import { remoteKeyPath } from '../src/remote/key';
import { HELP_TEXT } from '../src/config';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server';
import { TOOL_NAMES } from '../src/mcp/tools';

const CLI = join(__dirname, '..', 'src', 'cli.js');
const PKG_VERSION = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
const BUNDLED_EXT = resolve(__dirname, '..', '..', 'extension-dist');
const TOKEN = 'cli-test-token-0123456789';
const POSIX = process.platform !== 'win32';

interface Sandbox {
  home: string;
  dataDir: string;
  extDir: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(extraEnv: NodeJS.ProcessEnv = {}): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'cmcp-cli-'));
  const dataDir = join(home, 'data');
  const extDir = join(home, 'unpacked-extension');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(MCP_BROWSER_EXTENSION_|CHROME_MCP_)/.test(k)) delete env[k];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    MCP_BROWSER_EXTENSION_DATA: dataDir,
    MCP_BROWSER_EXTENSION_EXTENSION_DIR: extDir,
    MCP_BROWSER_EXTENSION_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    ...extraEnv,
  });
  return { home, dataDir, extDir, env };
}

interface Proc {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor: (stream: 'stdout' | 'stderr', pattern: RegExp, ms?: number) => Promise<RegExpExecArray>;
}

function start(t: TestContext, args: string[], env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.on('exit', (code, signal) => r({ code, signal })),
  );
  let done = false;
  void exited.then(() => (done = true));
  const kill = async (): Promise<void> => {
    if (!done) {
      child.kill('SIGKILL');
      await exited;
    }
  };
  live.add(kill);
  t.after(kill);
  const waitFor = async (stream: 'stdout' | 'stderr', pattern: RegExp, ms = 15_000): Promise<RegExpExecArray> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = pattern.exec(stream === 'stdout' ? out : err);
      if (hit) return hit;
      if (done || Date.now() > deadline) {
        throw new Error(`no ${pattern} on ${stream} (exited: ${done})\nstdout:\n${out}\nstderr:\n${err}`);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return { child, stdout: () => out, stderr: () => err, exited, waitFor };
}

async function runToEnd(t: TestContext, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const p = start(t, args, env);
  const { code } = await p.exited;
  return { code, stdout: p.stdout(), stderr: p.stderr() };
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** A hub bridge in this process; children with TOKEN join it as peers. */
async function hub(t: TestContext): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-cli-hub-'));
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 'test-hub', port: 0, heartbeatMs: 0, dataDir: dir });
  const port = await bridge.start();
  // Every child dies before the hub stops, so none can be promoted to hub.
  t.after(async () => {
    await Promise.all([...live].map((kill) => kill()));
    live.clear();
    await bridge.stop();
  });
  return port;
}

/** Kill switches for every child still running; a hub drains them before it stops. */
const live = new Set<() => Promise<void>>();

const SERVER_FLAGS = ['--no-auto-update', '--no-native-host', '--no-telemetry'];

// ---------------------------------------------------------------------------
// One-shot commands
// ---------------------------------------------------------------------------

test('--help prints the usage and the full tool catalog, wrapped', async (t) => {
  const s = sandbox();
  const r = await runToEnd(t, ['--help'], s.env);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith(HELP_TEXT));
  const tail = r.stdout.slice(HELP_TEXT.length);
  assert.match(tail, new RegExp(`^\\nTools \\(${TOOL_NAMES.length}\\) — any of these for --tools:\\n`));
  const listed = tail.split('\n').slice(2).join(' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(listed, [...TOOL_NAMES]);
  for (const line of tail.split('\n').slice(2)) assert.ok(line.length <= 78, `line too long: ${line}`);
  assert.equal(r.stderr, '');
  assert.equal(existsSync(s.dataDir), false, '--help creates nothing');
});

test('--version and -v print the package version', async (t) => {
  const s = sandbox();
  for (const flag of ['--version', '-v']) {
    const r = await runToEnd(t, [flag], s.env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `${PKG_VERSION}\n`);
  }
});

test('--extension-path mirrors the bundled extension into the install folder once', { skip: !existsSync(join(BUNDLED_EXT, 'manifest.json')) }, async (t) => {
  const s = sandbox();
  const first = await runToEnd(t, ['--extension-path'], s.env);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, `${s.extDir}\n`);
  assert.match(first.stderr, /developer extension files copied to .*this does not install the extension in Chrome/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(s.extDir, 'manifest.json'), 'utf8')).version,
    JSON.parse(readFileSync(join(BUNDLED_EXT, 'manifest.json'), 'utf8')).version,
  );
  const second = await runToEnd(t, ['--extension-path'], s.env);
  assert.equal(second.stdout, `${s.extDir}\n`);
  assert.doesNotMatch(second.stderr, /copied|updated/, 'already up to date: nothing to say');
});

test('--extension-path falls back to the bundled copy when the install folder cannot be written', { skip: !POSIX }, async (t) => {
  const s = sandbox();
  writeFileSync(join(s.home, 'a-file'), '');
  const env = { ...s.env, MCP_BROWSER_EXTENSION_EXTENSION_DIR: join(s.home, 'a-file', 'ext') };
  const r = await runToEnd(t, ['--extension-path'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${BUNDLED_EXT}\n`);
});

test('a bad flag is a one-line startup error with exit code 1, no stack', async (t) => {
  const s = sandbox();
  const unknown = await runToEnd(t, ['--bogus'], s.env);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown argument: --bogus/);
  assert.doesNotMatch(unknown.stderr, /fatal:|\n\s+at /);

  const port = await runToEnd(t, ['--port', 'abc'], s.env);
  assert.equal(port.code, 1);
  assert.match(port.stderr, /--port must be a non-negative integer/);

  const tunnel = await runToEnd(t, ['--no-email-verification', '--tunnel'], s.env);
  assert.equal(tunnel.code, 1);
  assert.match(tunnel.stderr, /--no-email-verification cannot be used with --tunnel/);

  const tools = await runToEnd(t, [...SERVER_FLAGS, '--tools', 'navigate,not_a_tool'], s.env);
  assert.equal(tools.code, 1);
  assert.match(tools.stderr, /not_a_tool/);
  assert.equal(existsSync(join(s.dataDir, 'handshake.json')), false, 'nothing started');
});

test('an unexpected startup failure is reported as fatal with its stack', async (t) => {
  const s = sandbox();
  const r = await runToEnd(t, ['--policy', join(s.home, 'missing-policy.json')], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /fatal: Error: ENOENT/);
  assert.match(r.stderr, /\n\s+at /);
});

// ---------------------------------------------------------------------------
// tasks list / gc
// ---------------------------------------------------------------------------

function seedTasks(dataDir: string): void {
  const old = ensureWorkspace(dataDir, 'default', 'old-run', { createdAt: '2020-01-01T00:00:00.000Z' });
  writeFileSync(join(old.downloadDir, 'big.bin'), Buffer.alloc(1_500_000));
  const mid = ensureWorkspace(dataDir, 'work', 'mid-run', { createdAt: '2021-06-01T00:00:00.000Z' });
  writeFileSync(join(mid.downloadDir, 'a.txt'), 'x'.repeat(4096));
  writeFileSync(join(mid.downloadDir, 'b.txt'), 'y');
  ensureWorkspace(dataDir, 'default', 'new-run', { createdAt: new Date().toISOString() });
}

test('tasks list: empty, table and --json', async (t) => {
  const s = sandbox();
  const empty = await runToEnd(t, ['tasks', 'list', '--data-dir', s.dataDir], s.env);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, 'no tasks found.\n');

  seedTasks(s.dataDir);
  const table = await runToEnd(t, ['tasks', 'list'], s.env);
  const rows = table.stdout.trim().split('\n');
  assert.equal(rows[0], 'PROFILE\tTASK\tCREATED\tFILES\tSIZE');
  const byTask = new Map(rows.slice(1).map((r) => [r.split('\t')[1], r.split('\t')]));
  assert.equal(byTask.get('old-run')?.[0], 'default');
  assert.equal(byTask.get('old-run')?.[3], '1');
  assert.match(byTask.get('old-run')?.[4] ?? '', /^1\.4 MB$/);
  assert.equal(byTask.get('mid-run')?.[3], '2');
  assert.match(byTask.get('mid-run')?.[4] ?? '', /^4\.\d KB$/);
  assert.match(byTask.get('new-run')?.[4] ?? '', /^\d+ B$/, 'under 1 KB is shown in bytes');

  const json = await runToEnd(t, ['tasks', 'list', '--json'], s.env);
  const tasks = JSON.parse(json.stdout) as Array<{ task: string; profile: string; downloads: number }>;
  assert.deepEqual(tasks.map((x) => x.task).sort(), ['mid-run', 'new-run', 'old-run']);
});

test('tasks gc: needs a limit; --dry-run removes nothing; a real run removes old tasks', async (t) => {
  const s = sandbox();
  seedTasks(s.dataDir);
  const noLimit = await runToEnd(t, ['tasks', 'gc'], s.env);
  assert.equal(noLimit.code, 1);
  assert.equal(noLimit.stderr, 'tasks gc: pass --older-than <days> and/or --keep <n>.\n');

  const dry = await runToEnd(t, ['tasks', 'gc', '--older-than', '30', '--dry-run'], s.env);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /^\[dry-run\] would remove 2 task\(s\), 1\.4 MB\n/);
  assert.match(dry.stdout, /  default\/old-run \(1\.4 MB\)\n/);
  assert.match(dry.stdout, /  work\/mid-run \(4\.\d KB\)\n/);
  assert.ok(existsSync(join(s.dataDir, 'profiles', 'default', 'tasks', 'old-run')));

  const scoped = await runToEnd(t, ['tasks', 'gc', '--older-than', '30', '--profile', 'work'], s.env);
  assert.match(scoped.stdout, /^removed 1 task\(s\), 4\.\d KB\n  work\/mid-run/);
  assert.equal(existsSync(join(s.dataDir, 'profiles', 'work', 'tasks', 'mid-run')), false);
  assert.ok(existsSync(join(s.dataDir, 'profiles', 'default', 'tasks', 'old-run')), 'other profiles untouched');

  const keep = await runToEnd(t, ['tasks', 'gc', '--keep', '1'], s.env);
  assert.match(keep.stdout, /^removed 1 task\(s\)/);
  assert.ok(existsSync(join(s.dataDir, 'profiles', 'default', 'tasks', 'new-run')), 'the newest is kept');
});

test('tasks with no or an unknown subcommand prints its help', async (t) => {
  const s = sandbox();
  for (const argv of [['tasks'], ['tasks', 'prune']]) {
    const r = await runToEnd(t, argv, s.env);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^mcp-browser-extension tasks — inspect and prune per-profile task workspaces\./);
  }
});

test('the extension subcommand is dispatched before flag parsing', async (t) => {
  const s = sandbox();
  const r = await runToEnd(t, ['extension', 'help'], s.env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^mcp-browser-extension extension — /);
});

// ---------------------------------------------------------------------------
// Server modes (as a peer of an in-process hub)
// ---------------------------------------------------------------------------

test('--print-pairing joins the running hub as a peer, prints the handshake path, and exits on Ctrl-C', async (t) => {
  const port = await hub(t);
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const p = start(t, [...SERVER_FLAGS, '--port', String(port), '--print-pairing'], s.env);
  await p.waitFor('stdout', /handshake\.json\n/);
  assert.equal(p.stdout(), `${join(s.dataDir, 'handshake.json')}\n`);
  await p.waitFor('stderr', /pairing mode — bridge is up/);
  assert.match(p.stderr(), new RegExp(`sharing the browsers of the mcp-browser-extension already on port ${port}`));
  assert.match(p.stderr(), /token: pinned from MCP_BROWSER_EXTENSION_TOKEN/);
  assert.doesNotMatch(p.stderr(), new RegExp(TOKEN), 'the token is never logged');
  assert.equal(existsSync(join(s.dataDir, 'handshake.json')), false, 'a peer publishes no handshake');
  p.child.kill('SIGINT');
  const { code } = await p.exited;
  assert.equal(code, 0);
});

/** Send one JSON-RPC message over the child's stdin. */
function rpc(p: Proc, msg: unknown): void {
  p.child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli-test', version: '1.0.0' } },
};

test('stdio mode: answers initialize with the server identity, then exits cleanly when stdin closes', async (t) => {
  const port = await hub(t);
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const p = start(t, [...SERVER_FLAGS, '--port', String(port), '--profile', 'cli', '--task', 'run-1'], s.env);
  await p.waitFor('stderr', /connected over stdio/);
  assert.match(p.stderr(), new RegExp(`mcp-browser-extension v${PKG_VERSION.replace(/\./g, '\\.')} connected over stdio`));
  assert.match(p.stderr(), /workspace: profile "cli" task "run-1"/);
  assert.match(p.stderr(), /backend: extension-if-paired else none \(prefer: extension\)/);
  assert.ok(existsSync(join(s.dataDir, 'profiles', 'cli', 'tasks', 'run-1', 'meta.json')));

  rpc(p, INIT);
  const line = await p.waitFor('stdout', /^.*"id":1.*\n/m);
  const res = JSON.parse(line[0]) as { result: { serverInfo: { name: string; version: string }; instructions: string; capabilities: Record<string, unknown> } };
  assert.equal(res.result.serverInfo.name, 'mcp-browser-extension');
  assert.equal(res.result.serverInfo.version, PKG_VERSION);
  assert.equal(res.result.instructions, SERVER_INSTRUCTIONS);
  assert.ok(res.result.capabilities.tools);

  p.child.stdin?.end();
  const { code } = await p.exited;
  assert.equal(code, 0);
  assert.match(p.stderr(), /MCP server stopped\./);
  for (const l of p.stdout().trim().split('\n')) JSON.parse(l); // stdout carried JSON-RPC only
});

test('stdio mode: --no-email-verification warns and advertises the local-bypass instructions; SIGTERM exits', async (t) => {
  const port = await hub(t);
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const p = start(t, [...SERVER_FLAGS, '--port', String(port), '--no-email-verification', '--log-level', 'debug'], s.env);
  await p.waitFor('stderr', /connected over stdio/);
  assert.match(p.stderr(), /SECURITY: hosted email verification is disabled/);
  assert.match(p.stderr(), /resolved config: \{"wsPort":\d+/, '--log-level debug shows the resolved config');
  assert.doesNotMatch(p.stderr(), new RegExp(TOKEN));
  rpc(p, INIT);
  const line = await p.waitFor('stdout', /^.*"id":1.*\n/m);
  assert.match(JSON.parse(line[0]).result.instructions, /^Email verification is disabled by the local operator/);
  p.child.kill('SIGTERM');
  const { code } = await p.exited;
  assert.equal(code, 0);
});

test('--http serves MCP on loopback, prints the connector URL with the key, and rejects keyless requests', async (t) => {
  const port = await hub(t);
  const httpPort = await freePort();
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const p = start(t, [...SERVER_FLAGS, '--port', String(port), '--http', '--http-port', String(httpPort), '--unsafe-all-domains'], s.env);
  await p.waitFor('stdout', /Cut everyone off/);
  const key = readFileSync(remoteKeyPath(s.dataDir), 'utf8').trim();
  const out = p.stdout();
  assert.match(out, new RegExp(`serving MCP over HTTP on 127\\.0\\.0\\.1:${httpPort}\\.`));
  assert.ok(out.includes(`  http://127.0.0.1:${httpPort}/mcp/${key}\n`));
  assert.ok(out.includes(`--header "Authorization: Bearer ${key}"`));
  assert.match(out, /WARNING: --unsafe-all-domains is on/);
  assert.doesNotMatch(out, /tunnel URL changes/);

  const base = `http://127.0.0.1:${httpPort}`;
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 404, 'no key: nothing there');
  const withKey = `${base}/mcp/${key}`;
  const bad = await fetch(withKey, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const noInit = await fetch(withKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  assert.equal(noInit.status, 400);
  assert.match(await noInit.text(), /send initialize first/);
  const unknownSession = await fetch(withKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  });
  assert.equal(unknownSession.status, 404);
  assert.equal((await fetch(withKey)).status, 404, 'GET without a session');
  const put = await fetch(withKey, { method: 'PUT' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get('allow'), 'GET, POST, DELETE');

  p.child.kill('SIGINT');
  const { code } = await p.exited;
  assert.equal(code, 0);
});

test('--http: a busy --http-port is a friendly startup error', async (t) => {
  const port = await hub(t);
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => blocker.close(() => r())));
  const busy = (blocker.address() as AddressInfo).port;
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const r = await runToEnd(t, [...SERVER_FLAGS, '--port', String(port), '--http', '--http-port', String(busy)], s.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`Couldn't start: port ${busy} is in use\\. Pass --http-port <n> to pick another\\.`));
  assert.doesNotMatch(r.stderr, /fatal:/);
});

test('--tunnel prints the public tunnel URL from cloudflared', { skip: !POSIX }, async (t) => {
  const port = await hub(t);
  const httpPort = await freePort();
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const bin = join(s.home, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'cloudflared'),
    `#!${process.execPath}\nprocess.stderr.write('INF |  https://quiet-river-stone-lamp.trycloudflare.com  |\\n');\nsetInterval(() => {}, 1000);\n`,
  );
  chmodSync(join(bin, 'cloudflared'), 0o755);
  const p = start(t, [...SERVER_FLAGS, '--port', String(port), '--tunnel', '--http-port', String(httpPort)], { ...s.env, PATH: bin });
  await p.waitFor('stdout', /The tunnel URL changes every time this starts\./);
  const key = readFileSync(remoteKeyPath(s.dataDir), 'utf8').trim();
  assert.match(p.stdout(), /MCP Browser Extension is reachable from anywhere\./);
  assert.ok(p.stdout().includes(`  https://quiet-river-stone-lamp.trycloudflare.com/mcp/${key}\n`));
  p.child.kill('SIGTERM');
  const { code } = await p.exited;
  assert.equal(code, 0);
});

test('--tunnel without cloudflared installed stops with the install hint', { skip: !POSIX }, async (t) => {
  const port = await hub(t);
  const httpPort = await freePort();
  const s = sandbox({ MCP_BROWSER_EXTENSION_TOKEN: TOKEN });
  const empty = join(s.home, 'empty-bin');
  mkdirSync(empty);
  const r = await runToEnd(t, [...SERVER_FLAGS, '--port', String(port), '--tunnel', '--http-port', String(httpPort), '--rotate-remote-key'], {
    ...s.env,
    PATH: empty,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /remote key rotated: every earlier connector URL stops working\./);
  assert.match(r.stderr, /Couldn't start: --tunnel needs cloudflared, which is not installed\./);
  // The HTTP listener was closed again on the way out.
  const probe = createServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(httpPort, '127.0.0.1', () => resolveListen());
  });
  await new Promise<void>((r2) => probe.close(() => r2()));
});
