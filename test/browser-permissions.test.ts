import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isGlobalOrigin, originForUrl, siteOrigins } from '../shared/browser-permissions';

test('site permission requests cannot expand into blanket, file or browser access', () => {
  for (const input of ['*', '<all_urls>', '*://*/*', 'https://*/*', '*.', 'file:///tmp/private',
    'chrome://settings', 'chrome-extension://abc/options.html', 'a*.com', 'https://evil.com\\@*/*']) {
    assert.deepEqual(siteOrigins(input), [], input);
  }
  assert.deepEqual(siteOrigins('https://Example.COM:8080/path?q=1'), ['http://example.com/*', 'https://example.com/*']);
  assert.deepEqual(siteOrigins('*.example.com'), ['http://*.example.com/*', 'https://*.example.com/*']);
  assert.deepEqual(siteOrigins('localhost'), ['http://localhost/*', 'https://localhost/*']);
  assert.equal(originForUrl('http://127.0.0.1:1234/path'), 'http://127.0.0.1/*');
  assert.equal(originForUrl('file:///tmp/private'), null);
});

test('upgrade cleanup distinguishes global grants from a named site or its subdomains', () => {
  for (const pattern of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', 'file://*/*']) assert.ok(isGlobalOrigin(pattern));
  for (const pattern of ['https://example.com/*', 'https://*.example.com/*', 'http://127.0.0.1/*']) assert.ok(!isGlobalOrigin(pattern));
});

test('the shipped manifest requires no host grant or optional feature at install time', () => {
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  for (const permission of ['cookies', 'downloads', 'webRequest', 'webRequestAuthProvider']) {
    assert.ok(!manifest.permissions.includes(permission), permission);
    assert.ok(manifest.optional_permissions.includes(permission), permission);
  }
  assert.ok(manifest.permissions.includes('debugger'), 'Chrome does not allow debugger to be optional');
  assert.ok(manifest.permissions.includes('proxy'), 'Chrome does not allow proxy to be optional');
  assert.equal(manifest.content_scripts, undefined, 'no static script may recreate blanket host access');
});
