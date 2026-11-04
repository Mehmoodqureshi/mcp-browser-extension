import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_E2E, startHarness, textOf } from './harness';

test('reading a page with large embedded data keeps the browser connected', { skip: !RUN_E2E }, async () => {
  const h = await startHarness();
  try {
    const tabId = await h.open('/markdown');
    const page = h.ctx.pages().find((page) => page.url() === `${h.base}/markdown`)!;
    await page.evaluate(() => {
      const data = document.createElement('script');
      data.type = 'application/json';
      data.textContent = JSON.stringify({ fixture: 'x'.repeat(5 * 1024 * 1024) });
      document.body.append(data);
    });
    const result = await h.call('read_as_markdown', { tabId });
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /Heading One/);
    assert.match(textOf(result), /item b/);
    assert.equal(h.bridge.hasActiveExtension(), true);
    const raw = await h.call('get_html', { tabId });
    assert.equal(raw.isError, true);
    assert.match(textOf(raw), /RESULT_TOO_LARGE/);
    assert.equal(h.bridge.hasActiveExtension(), true, 'a large raw result does not interrupt other clients');
    const section = await h.call('get_html', { tabId, selector: 'h1' });
    assert.notEqual(section.isError, true, textOf(section));
    assert.match(textOf(section), /Heading One/);
    assert.notEqual((await h.call('tabs_list')).isError, true);
  } finally { await h.close(); }
});
