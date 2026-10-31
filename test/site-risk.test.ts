import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteUrlWarnings, loginWarnings, type LoginSignals } from '../shared/site-risk';
import { evaluatePolicy } from '../shared/policy';
import { resolvePolicy } from '../src/security/policy';

test('ordinary addresses, international names and normal login pages do not need a warning', () => {
  for (const url of ['https://example.com/login', 'https://accounts.google.com/', 'https://login.microsoftonline.com/',
    'https://paypal.com/', 'https://bücher.de/', 'https://пример.рф/', 'https://example.com/articles/paypal-login',
    'https://google.com.pk/', 'http://localhost:3000/', 'https://github.com/']) {
    assert.deepEqual(siteUrlWarnings(url), [], url);
  }
  assert.deepEqual(loginWarnings({ url: 'https://example.com/login', title: 'Sign in', passwords: 1,
    forms: [{ action: 'https://accounts.example.com/login', method: 'post' }] }), []);
  assert.deepEqual(loginWarnings({ url: 'http://localhost:3000/login', title: 'Sign in', passwords: 1,
    forms: [{ action: '/login', method: 'post' }] }), []);
});

test('local address rules explain brand impersonation without visiting the website', () => {
  const cases = [
    ['https://paypal.com.evil.test/', 'misleading-domain:paypal'],
    ['https://paypa1.com/', 'lookalike:paypal'],
    ['https://аррӏе.com/', 'lookalike:apple'],
    ['https://google-login.example/', 'brand-login:google'],
    ['https://paypal.com@evil.test/', 'hidden-destination'],
  ];
  for (const [url, expected] of cases) assert.ok(siteUrlWarnings(url).some((w) => w.id === expected), `${url}: ${JSON.stringify(siteUrlWarnings(url))}`);
});

test('a real password form can introduce warnings after a previously ordinary URL', () => {
  const base: LoginSignals = { url: 'https://example.com/', title: 'Sign in', passwords: 1, forms: [] };
  assert.ok(loginWarnings({ ...base, url: 'http://example.com/' }).some((w) => w.id === 'unencrypted-login'));
  assert.ok(loginWarnings({ ...base, forms: [{ action: 'http://receiver.test/login', method: 'post' }] }).some((w) => w.id.startsWith('unencrypted-password-destination:')));
  assert.ok(loginWarnings({ ...base, forms: [{ action: '/login', method: 'get' }] }).some((w) => w.id === 'password-in-address'));
  assert.ok(loginWarnings({ ...base, title: 'Sign in to Google' }).some((w) => w.id === 'login-brand:google'));
  assert.deepEqual(loginWarnings({ ...base, title: 'Sign in with Google', passwords: 0 }), []);
  assert.deepEqual(loginWarnings({ ...base, title: 'Google news and articles' }), []);
  assert.deepEqual(loginWarnings({ ...base, title: 'Sign in to Google', url: 'https://accounts.google.com/' }), []);
});

test('automatic site policy preserves capability restrictions, explicit blocks and internal-page restrictions', () => {
  const base = resolvePolicy();
  const automatic = { ...base, automaticSites: true, blockedDomains: ['example.com'] };
  assert.equal(evaluatePolicy('https://ordinary.test/', 'get_text', automatic).ok, true);
  assert.equal(evaluatePolicy('https://example.com/', 'get_text', automatic).ok, false);
  assert.equal(evaluatePolicy('https://ordinary.test/', 'click', automatic).ok, false);
  assert.equal(evaluatePolicy('https://ordinary.test/', 'eval', automatic).ok, false);
  assert.equal(evaluatePolicy('https://ordinary.test/', 'upload_file', automatic).ok, false);
  assert.equal(evaluatePolicy('file:///tmp/private', 'get_text', automatic).ok, false);
  assert.equal(evaluatePolicy('chrome://settings', 'get_text', automatic).ok, false);
  assert.equal(resolvePolicy({ automaticSites: true }).automaticSites, undefined, 'server policy files cannot enable a browser setting');
});
