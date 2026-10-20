/**
 * Use Chrome's real per-tab zoom, not CSS zoom or a resized viewport. Check the
 * pixels at every edge: the old capture could have plausible dimensions while
 * showing the wrong part of the page.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, RUN_E2E, startHarness, textOf, type Harness } from './harness';

PAGES['/zoom-viewport'] = `<!doctype html><title>Zoom viewport</title>
  <style>
    body { margin:0; width:2200px; height:2600px; background:#ddd }
    .corner { position:fixed; width:32px; height:32px }
  </style>
  <div class="corner" style="left:4px;top:4px;background:#f00"></div>
  <div class="corner" style="right:4px;top:4px;background:#0f0"></div>
  <div class="corner" style="left:4px;bottom:4px;background:#00f"></div>
  <div class="corner" style="right:4px;bottom:4px;background:#f0f"></div>`;

PAGES['/zoom-document'] = `<!doctype html><title>Zoom document</title>
  <style>
    body { margin:0; width:2000px; height:2400px; background:#ddd }
    .corners { background:conic-gradient(#0f0 0 25%,#f0f 0 50%,#00f 0 75%,#f00 0) }
    #document { position:absolute; inset:0 auto auto 0; width:2000px; height:2400px }
    #element { position:absolute; left:420px; top:1350px; width:240px; height:160px }
  </style>
  <div id="document" class="corners"></div><div id="element" class="corners"></div>`;

interface Geometry { w: number; h: number; fullW: number; fullH: number; dpr: number }
const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 0, 255]];

for (const deviceScaleFactor of [1, 2]) {
  describe(`screenshots with display scale ${deviceScaleFactor}`, { skip: !RUN_E2E }, () => {
    let h: Harness;
    before(async () => { h = await startHarness({}, { deviceScaleFactor }); });
    after(async () => { await h?.close(); });

    for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
      for (const mode of ['viewport', 'scrolled', 'fullPage', 'element'] as const) {
        test(`${mode} at ${zoom * 100}% zoom`, async () => {
          const tab = await h.open(mode === 'viewport' || mode === 'scrolled' ? '/zoom-viewport' : '/zoom-document');
          const id = Number(tab.split(':').pop());
          try {
            await h.sw.evaluate(async ({ id, zoom }) => {
              type Chrome = { tabs: {
                setZoomSettings(id: number, settings: object): Promise<void>;
                setZoom(id: number, zoom: number): Promise<void>;
              } };
              const c = (globalThis as unknown as { chrome: Chrome }).chrome;
              await c.tabs.setZoomSettings(id, { mode: 'automatic', scope: 'per-tab' });
              await c.tabs.setZoom(id, zoom);
            }, { id, zoom });
            if (mode !== 'viewport') await h.json('scroll', { tabId: tab, x: 120, y: 600 });
            const geometry = (await h.json<{ value: Geometry }>('eval', {
              tabId: tab,
              expression: '({ w:innerWidth, h:innerHeight, fullW:document.documentElement.scrollWidth, fullH:document.documentElement.scrollHeight, dpr:devicePixelRatio })',
            })).value;
            assert.ok(Math.abs(geometry.dpr - deviceScaleFactor * zoom) < 0.001,
              `the page must use the requested display scale and zoom (DPR ${geometry.dpr})`);
            const scale = zoom === 1.5 ? 0.5 : zoom === 2 ? 2 : 1;
            const shot = await h.call('screenshot', {
              tabId: tab, format: 'png', scale,
              ...(mode === 'fullPage' ? { fullPage: true } : {}),
              ...(mode === 'element' ? { selector: '#element' } : {}),
            });
            assert.notEqual(shot.isError, true, textOf(shot));
            const img = shot.content.find((c) => c.type === 'image');
            assert.ok(img && img.type === 'image', textOf(shot));
            const pixels = await h.sw.evaluate(async ({ data, scale }) => {
              const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
              const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
              try {
                const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
                ctx.drawImage(bmp, 0, 0);
                const inset = Math.round(20 * scale);
                return {
                  w: bmp.width, h: bmp.height,
                  corners: [[inset, inset], [bmp.width - inset, inset],
                    [inset, bmp.height - inset], [bmp.width - inset, bmp.height - inset]]
                    .map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3)),
                };
              } finally {
                bmp.close();
              }
            }, { data: img.data, scale });
            const w = mode === 'element' ? 240 : mode === 'fullPage' ? geometry.fullW : geometry.w;
            const ht = mode === 'element' ? 160 : mode === 'fullPage' ? geometry.fullH : geometry.h;
            assert.ok(Math.abs(pixels.w - Math.round(w * scale)) <= 1, `width: ${pixels.w}, expected ${w * scale}`);
            assert.ok(Math.abs(pixels.h - Math.round(ht * scale)) <= 1, `height: ${pixels.h}, expected ${ht * scale}`);
            assert.deepEqual(pixels.corners, colors, 'all four corners must be included and correctly positioned');
            const currentZoom = await h.sw.evaluate(async (id) => {
              const c = (globalThis as unknown as { chrome: { tabs: { getZoom(id: number): Promise<number> } } }).chrome;
              return c.tabs.getZoom(id);
            }, id);
            assert.equal(currentZoom, zoom, 'taking a screenshot must preserve the tab zoom');
          } finally {
            await h.json('tab_close', { tabId: tab });
          }
        });
      }
    }
  });
}
