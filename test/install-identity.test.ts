import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

const source = buildSync({ entryPoints: ['extension/src/sw/install-identity.ts'], bundle: true,
  write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;

function worker(saved: Record<string, unknown>, write = async (values: object) => { Object.assign(saved, values); }) {
  const module = { exports: {} as { ensureInstallId(): Promise<string> } };
  runInNewContext(source, { module, exports: module.exports, crypto: { randomUUID },
    chrome: { storage: { local: { get: async () => ({ ...saved }), set: write } } } });
  return module.exports;
}

test('concurrent startup connections share the identity retained after a worker restart', async () => {
  const saved: Record<string, unknown> = {};
  const first = worker(saved);
  const ids = await Promise.all(Array.from({ length: 20 }, () => first.ensureInstallId()));
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids[0], saved.installId);
  assert.equal(await worker(saved).ensureInstallId(), ids[0]);
});

test('an existing installation keeps its identity without rewriting storage', async () => {
  const installId = randomUUID();
  const current = worker({ installId }, async () => { assert.fail('existing identity must not be rewritten'); });
  assert.equal(await current.ensureInstallId(), installId);
});

test('a failed identity write can retry without returning an unsaved identity', async () => {
  const saved: Record<string, unknown> = {};
  let writes = 0;
  const current = worker(saved, async values => {
    if (++writes === 1) throw new Error('storage unavailable');
    Object.assign(saved, values);
  });
  await assert.rejects(current.ensureInstallId(), /storage unavailable/);
  assert.equal(await current.ensureInstallId(), saved.installId);
});
