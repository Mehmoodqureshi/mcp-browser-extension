/**
 * person-wait — a tool call blocked on the person (app approval or site allow)
 * waits and continues on its own, instead of making the agent poll.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { personStep, setPersonWaitForTesting, STILL_WAITING, waitForPerson } from '../src/mcp/person-wait';

const err = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
const ok: CallToolResult = { content: [{ type: 'text', text: 'done' }] };
const APPROVE = 'Please approve "codex 1.0" (check key ab12): Chrome → MCP Browser Extension icon → App connections → Approve for 8 hours.';
const SITE = '[POLICY_DENIED] Please allow access to example.com: Chrome → MCP Browser Extension icon → Allow next to example.com, then try again.';

test('only approval and site refusals count as waiting on the person', () => {
  assert.equal(personStep(err(APPROVE)), APPROVE);
  assert.equal(personStep(err(SITE)), SITE);
  assert.equal(personStep(err('[TARGET_GONE] The extensions gallery cannot be scripted.')), undefined);
  assert.equal(personStep(err('[POLICY_DENIED] mutating tool "click" is disabled (safe-mode).')), undefined);
  assert.equal(personStep({ content: [{ type: 'text', text: SITE }] }), undefined);
});

test('continues on its own once the person approves', async () => {
  setPersonWaitForTesting(1, 1_000);
  let calls = 0;
  const progress: string[] = [];
  const result = await waitForPerson(async () => (++calls < 3 ? err(APPROVE) : ok), {
    progressToken: 't',
    sendNotification: async (n) => { progress.push(n.params.message); },
  });
  assert.deepEqual(result, ok);
  assert.equal(calls, 3);
  assert.match(progress[0], /Waiting for this automatically/);
});

test('returns at once when nothing is blocked', async () => {
  let calls = 0;
  assert.deepEqual(await waitForPerson(async () => { calls++; return ok; }, {}), ok);
  assert.equal(calls, 1);
});

test('gives up after the wait and tells the agent to call again', async () => {
  setPersonWaitForTesting(1, 20);
  const result = await waitForPerson(async () => err(SITE), {});
  assert.equal(result.isError, true);
  const last = result.content[result.content.length - 1];
  assert.equal(last.type === 'text' && last.text, STILL_WAITING);
});

test('stops waiting when the call is cancelled', async () => {
  setPersonWaitForTesting(1_000, 60_000);
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 10);
  const result = await waitForPerson(async () => err(APPROVE), { signal: ac.signal });
  assert.equal(result.isError, true);
  assert.ok(Date.now() - started < 1_000);
});
