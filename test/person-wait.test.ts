/**
 * person-wait — a tool call blocked on the person (app approval or site allow)
 * waits and continues on its own, instead of making the agent poll.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { notifyPersonStep, personStep, setPersonWaitForTesting, STILL_WAITING, waitForPerson } from '../src/mcp/person-wait';

const err = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
const ok: CallToolResult = { content: [{ type: 'text', text: 'done' }] };
const APPROVE = 'Please approve "codex 1.0" (check key ab12): Chrome → MCP Browser Extension icon → App connections → Approve for 8 hours.';
const SITE = '[POLICY_DENIED] Please allow access to example.com: in Chrome, click the MCP Browser Extension icon (inside the puzzle-piece Extensions menu if it is not pinned), then click Allow next to example.com.';

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

test('tells the caller which attempts are retries', async () => {
  setPersonWaitForTesting(1, 1_000);
  const retries: boolean[] = [];
  await waitForPerson(async (retry) => { retries.push(retry); return retries.length < 3 ? err(SITE) : ok; }, {});
  assert.deepEqual(retries, [false, true, true]);
});

test('retries once as soon as the person acts, not on the next poll', async () => {
  setPersonWaitForTesting(60_000, 120_000);
  let allowed = false;
  let calls = 0;
  const started = Date.now();
  setTimeout(() => { allowed = true; notifyPersonStep(); }, 30);
  const result = await waitForPerson(async () => { calls++; return allowed ? ok : err(SITE); }, {});
  assert.deepEqual(result, ok);
  assert.equal(calls, 2, 'one refusal, then one retry after the signal');
  assert.ok(Date.now() - started < 5_000, 'did not sit out the 60 s fallback poll');
});
