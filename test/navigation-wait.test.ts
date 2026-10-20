import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = buildSync({
  entryPoints: [join(__dirname, '../../extension/src/sw/executor.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node',
}).outputFiles[0].text;

for (const redirected of [false, true]) {
  test(`navigation ignores initial blank events and completes ${redirected ? 'an HTTP redirect' : 'the requested URL'}`, async () => {
    type EventData = { tabId: number; frameId: number; timeStamp: number; url: string; transitionQualifiers: string[] };
    const events: Record<string, { listeners: Set<(data: EventData) => void>; addListener(fn: (data: EventData) => void): void; removeListener(fn: (data: EventData) => void): void }> = {};
    for (const name of ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onErrorOccurred', 'onUpdated']) {
      const listeners = new Set<(data: EventData) => void>();
      events[name] = { listeners, addListener: (fn) => { listeners.add(fn); }, removeListener: (fn) => { listeners.delete(fn); } };
    }
    const module = { exports: {} as { armNavigationWait(id: number, stage: string, timeout: number, expected: string): { wait(): Promise<void>; cancel(): void } } };
    runInNewContext(source, { module, exports: module.exports, crypto: webcrypto, URL, setTimeout, clearTimeout, chrome: { webNavigation: events, tabs: { onUpdated: events.onUpdated, onRemoved: { addListener() {} } }, debugger: { onDetach: { addListener() {} } } } });
    const destination = 'https://example.com/requested';
    const landing = redirected ? 'https://example.com/redirected' : destination;
    const nav = module.exports.armNavigationWait(7, 'load', 1000, destination);
    let finished = false;
    const waiting = nav.wait().then(() => { finished = true; });
    const emit = (event: string, url: string, transitionQualifiers: string[] = []) => {
      for (const fn of events[event].listeners) fn({ tabId: 7, frameId: 0, timeStamp: Date.now(), url, transitionQualifiers });
    };
    try {
      emit('onBeforeNavigate', 'about:blank');
      emit('onCommitted', 'about:blank');
      emit('onCompleted', 'about:blank');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(finished, false, 'the blank page is not the requested navigation');
      emit('onBeforeNavigate', destination);
      emit('onCommitted', 'about:blank');
      emit('onCommitted', landing, redirected ? ['server_redirect'] : []);
      emit('onCompleted', 'about:blank');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(finished, false, 'a late load from the old document must not finish the new one');
      emit('onCompleted', landing);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(finished, true, 'the landing page must finish the wait without hitting the timeout');
      await waiting;
      assert.equal(finished, true);
      assert.ok(Object.values(events).every((event) => event.listeners.size === 0));
    } finally { nav.cancel(); }
  });
}
