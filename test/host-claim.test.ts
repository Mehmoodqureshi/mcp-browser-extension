/**
 * A host that reconnects by spawning a new child, without closing the old one's
 * stdin, must not leave the old server serving the browser with stale flags.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimHost, supersededBy } from '../src/bridge/host-claim';

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'host-claim-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the newest server from the same parent and profile supersedes the older one', () => {
  withDir((dir) => {
    claimHost(dir, 500, 'default', 1001);
    assert.equal(supersededBy(dir, 500, 'default', 1001), null);
    claimHost(dir, 500, 'default', 1002);
    assert.equal(supersededBy(dir, 500, 'default', 1001), 1002);
    assert.equal(supersededBy(dir, 500, 'default', 1002), null);
  });
});

test('other parents and other profiles are independent', () => {
  withDir((dir) => {
    claimHost(dir, 500, 'default', 1001);
    claimHost(dir, 600, 'default', 2001);
    claimHost(dir, 500, 'work', 3001);
    assert.equal(supersededBy(dir, 500, 'default', 1001), null);
    assert.equal(supersededBy(dir, 600, 'default', 2001), null);
    assert.equal(supersededBy(dir, 500, 'work', 3001), null);
  });
});

test('a missing or garbled claim never retires a server', () => {
  withDir((dir) => {
    assert.equal(supersededBy(dir, 500, 'default', 1001), null);
    claimHost(dir, 500, '../odd/name', 1001);
    assert.equal(supersededBy(dir, 500, '../odd/name', 1001), null);
  });
});
