import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareWatch, createWatch, listWatches, readWatch, removeWatch, safeSnapshot } from '../src/mcp/page-watch';
import type { SnapshotResult } from '../src/executor/types';
import { dispatchToolCall } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';
import { ensureWorkspace } from '../src/bridge/datadir';
import { resetActiveWorkspaceForTesting, setActiveWorkspace } from '../src/bridge/workspace';

function fixture(name = 'Save', value?: string): SnapshotResult {
  return { url: 'https://example.com/account?token=secret#private', title: 'Account', truncated: false,
    nodes: [{ ref: 'e1', role: 'button', name, tag: 'button', ...(value ? { value } : {}) }] };
}

test('page watch stores an atomic profile-local checkpoint without form values or URL query data', () => {
  const base = mkdtempSync(join(tmpdir(), 'page-watch-'));
  const profileDir = join(base, 'profiles', 'work');
  try {
    const clean = safeSnapshot(fixture('Save', 'private input'), (s) => s);
    const saved = createWatch(profileDir, 'Account page', clean);
    assert.equal(readWatch(profileDir, saved.id).nodes[0].value, undefined);
    assert.equal(saved.url, 'https://example.com/account');
    assert.equal(listWatches(profileDir).length, 1);
    const file = join(profileDir, 'page-watches', `${saved.id}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /private input|token=secret/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('page watch compares state and removes checkpoints; rejects path-like ids', () => {
  const base = mkdtempSync(join(tmpdir(), 'page-watch-'));
  try {
    const profileDir = join(base, 'profiles', 'default');
    const saved = createWatch(profileDir, 'Original', safeSnapshot(fixture('Save'), (s) => s));
    const diff = compareWatch(saved, fixture('Continue'), (s) => s);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 1);
    assert.throws(() => readWatch(profileDir, '../escape'), /invalid watchId/);
    removeWatch(profileDir, saved.id);
    assert.deepEqual(listWatches(profileDir), []);
    assert.throws(() => readWatch(profileDir, saved.id), /not found/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('configured secret patterns are removed from persisted accessibility labels', () => {
  const safe = safeSnapshot(fixture('user@example.com'), (s) => s.replace(/user@example\.com/g, '[REDACTED]'));
  assert.equal(safe.nodes[0].name, '[REDACTED]');
});

test('page_watch MCP actions create, compare, list, and delete through dispatch', async () => {
  const base = mkdtempSync(join(tmpdir(), 'page-watch-tool-'));
  const ex = new StubExecutor({ activeUrl: 'https://example.com/pricing', snapshotNodes: [
    { ref: 'e1', role: 'button', name: 'Starter', tag: 'button' },
  ] });
  try {
    resetActiveWorkspaceForTesting();
    resetManagerForTesting();
    setActiveWorkspace(ensureWorkspace(base, 'work', 'default'));
    configureManager({ policy: resolvePolicy({ allowDomains: ['example.com'] }), makeExecutor: () => ex });

    const created = await dispatchToolCall('page_watch', { action: 'create', name: 'Pricing' });
    assert.notEqual(created.isError, true);
    const watchId = JSON.parse(created.content[0].type === 'text' ? created.content[0].text : '{}').watchId as string;
    assert.match(watchId, /^watch_/);

    configureManager({ policy: resolvePolicy({ allowDomains: ['other.test'] }), makeExecutor: () => new StubExecutor({ activeUrl: 'https://other.test/' }) });
    const revoked = await dispatchToolCall('page_watch', { action: 'compare', watchId });
    assert.equal(revoked.isError, true, 'a revoked domain grant must not reveal a saved checkpoint');
    configureManager({ policy: resolvePolicy({ allowDomains: ['example.com'] }), makeExecutor: () => ex });

    ex.snapshotNodes = [{ ref: 'e1', role: 'button', name: 'Pro', tag: 'button' }];
    const compared = await dispatchToolCall('page_watch', { action: 'compare', watchId });
    assert.notEqual(compared.isError, true);
    const diff = JSON.parse(compared.content[0].type === 'text' ? compared.content[0].text : '{}') as { added: unknown[]; removed: unknown[] };
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 1);

    const listed = await dispatchToolCall('page_watch', { action: 'list' });
    assert.match(listed.content[0].type === 'text' ? listed.content[0].text : '', /Pricing/);
    configureManager({ policy: resolvePolicy({ allowDomains: ['example.com'] }) }); // list/delete need no attached browser
    const deleted = await dispatchToolCall('page_watch', { action: 'delete', watchId });
    assert.notEqual(deleted.isError, true);
  } finally {
    resetManagerForTesting();
    resetActiveWorkspaceForTesting();
    rmSync(base, { recursive: true, force: true });
  }
});
