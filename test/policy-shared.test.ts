/**
 * shared/policy.ts is the SINGLE policy decision both ends run. These tests pin
 * (a) the deny-all default, and (b) that the server's `assertUrlAllowed` wrapper
 * agrees with the shared `evaluatePolicy` across a method/url/policy matrix — the
 * invariant that lets the server and the extension router enforce identically.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePolicy, DENY_ALL_WIRE_POLICY, blockedDomainMessage } from '../shared/policy';
import { observerMatches } from '../shared/observers';
import { WIRE_METHODS, type WireMethod } from '../shared/protocol';
import { assertUrlAllowed, resolvePolicy } from '../src/security/policy';
import { ExecutorError } from '../src/executor/types';

const URLS = ['https://example.com/p', 'https://evil.test/p', 'about:blank', ''];

const POLICIES = [
  resolvePolicy({}), // deny-all default
  resolvePolicy({ allowDomains: ['example.com'] }), // reads on example.com only
  resolvePolicy({ allowDomains: ['example.com'], enableMutations: true }),
  resolvePolicy({
    allowDomains: ['example.com', 'evil.test'],
    enableMutations: true,
    allowEval: true,
    allowDownloads: true,
    allowUploads: true,
  }),
];

function serverAllows(url: string, method: WireMethod, policy: Parameters<typeof assertUrlAllowed>[2]): boolean {
  try {
    assertUrlAllowed(url, method, policy);
    return true;
  } catch (e) {
    assert.ok(e instanceof ExecutorError && e.code === 'POLICY_DENIED', 'denial must be POLICY_DENIED');
    return false;
  }
}

test('evaluatePolicy agrees with assertUrlAllowed across the full matrix', () => {
  for (const method of WIRE_METHODS) {
    for (const url of URLS) {
      for (const policy of POLICIES) {
        const shared = evaluatePolicy(url, method, policy).ok;
        const server = serverAllows(url, method, policy);
        assert.equal(
          shared,
          server,
          `mismatch for method=${method} url=${url || '<empty>'}: shared=${shared} server=${server}`,
        );
      }
    }
  }
});

test('deny-all default blocks reads, navigation, eval, and uploads', () => {
  const p = DENY_ALL_WIRE_POLICY;
  assert.equal(evaluatePolicy('https://example.com', 'get_text', p).ok, false);
  assert.equal(evaluatePolicy('https://example.com', 'navigate', p).ok, false);
  assert.equal(evaluatePolicy('https://example.com', 'eval', p).ok, false);
  assert.equal(evaluatePolicy('https://example.com', 'upload_file', p).ok, false);
});

test('non-url-gated methods (tabs_list, ping_probe) pass regardless of url', () => {
  const p = DENY_ALL_WIRE_POLICY;
  assert.equal(evaluatePolicy('', 'tabs_list', p).ok, true);
  assert.equal(evaluatePolicy('', 'ping_probe', p).ok, true);
});

test('raw legacy catch-all policies cannot permit reads, actions or observer registration', () => {
  for (const pattern of ['*', '*://*/*', 'https://*/*', 'http://*:8080/path', '<all_urls>', '*.']) {
    const policy = {
      ...DENY_ALL_WIRE_POLICY, allowDomains: [pattern], enableMutations: true,
      allowEval: true, allowDownloads: true, allowUploads: true, allowObservers: true,
    };
    for (const method of ['get_text', 'screenshot', 'navigate', 'click', 'eval', 'download_file', 'upload_file', 'observers'] as const) {
      for (const url of ['https://example.com/', 'https://other.test/', 'https://example.com./']) {
        assert.equal(evaluatePolicy(url, method, policy).ok, false, `${pattern}: ${method} ${url}`);
      }
    }
    assert.deepEqual(observerMatches(policy), []);
    policy.allowDomains.push('example.com');
    assert.equal(evaluatePolicy('https://example.com/', 'get_text', policy).ok, true);
    assert.equal(evaluatePolicy('https://other.test/', 'get_text', policy).ok, false);
    assert.deepEqual(observerMatches(policy), ['*://example.com/*']);
  }
});

test('site approval instructions are one friendly line with no blanket-access alternative', () => {
  const message = blockedDomainMessage('example.com');
  assert.equal(message, 'Please allow access to example.com: Chrome → MCP Browser Extension icon → Allow next to example.com, then try again.');
  assert.doesNotMatch(message, /[\r\n]|--unsafe|--allow-domain/);
});
