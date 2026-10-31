/** Real extension round trip in a disposable, headless Chromium profile. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('extension pairs and round-trips navigate to get_text', { skip: !process.env.RUN_EXT_SMOKE }, async () => {
  // Reuse current pairing, app approval and optional permission setup. The
  // legacy smoke fixture predates those gates and required a visible browser.
  const { startHarness } = await import('./e2e/harness');
  const h = await startHarness();
  try {
    const tabId = await h.open('/');
    const nav = await h.bridge.sendCommand('navigate', { url: `${h.base}/form` }, { tabId }) as { url: string };
    assert.equal(nav.url, `${h.base}/form`);
    const text = await h.bridge.sendCommand('get_text', {}, { tabId }) as { text: string };
    assert.match(text.text, /Name/);
  } finally { await h.close(); }
});
