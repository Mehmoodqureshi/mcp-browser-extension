/**
 * src/mcp/person-wait.ts — hold a tool call open while the PERSON approves the
 * app or allows a site in Chrome, then continue on its own.
 *
 * Without this the agent gets an error, tells the person, and has to invent its
 * own polling (shell sleeps, "I'll check again in a minute"). Waiting here means
 * one tool call simply completes once the person clicks Approve/Allow.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface PersonWaitRequest {
  signal?: AbortSignal;
  progressToken?: string | number;
  sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;
}

// A fallback only: an approval or site grant wakes the wait at once (below).
let pollMs = 10_000;
// Stay under the 60 s default tool timeout some MCP clients enforce.
let waitMs = 45_000;

export function setPersonWaitForTesting(poll: number, wait: number): void {
  pollMs = Math.max(1, poll);
  waitMs = Math.max(1, wait);
}

const wakers = new Set<() => void>();

/**
 * The person just approved an app or allowed a site: retry every waiting call
 * now instead of on the next fallback poll.
 */
export function notifyPersonStep(): void {
  for (const wake of [...wakers]) wake();
}

const APPROVAL = /Please approve "/;
const SITE = /^\[POLICY_DENIED\] Please allow access to /;
const SITE_WARNING = /^\[POLICY_DENIED\] (Suspicious website |Automatic website access needs Chrome permission\.)/;

/** The person-only step a result is blocked on, or undefined when it is not. */
export function personStep(result: CallToolResult): string | undefined {
  if (!result.isError) return undefined;
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return APPROVAL.test(text) || SITE.test(text) || SITE_WARNING.test(text) ? text : undefined;
}

export const STILL_WAITING =
  'Still waiting for the person. Call the same tool again to keep waiting; it continues on its own once they approve. ' +
  'Do not use shell sleeps or ask them to confirm in chat.';

/**
 * Run `attempt` until it is no longer blocked on the person, the wait expires,
 * or the call is cancelled. Only results that ran nothing (approval / site
 * gate refusals) are retried. `retry` is true on every attempt after the
 * first, so the caller can count one refusal per wait instead of one per poll.
 */
export async function waitForPerson(attempt: (retry: boolean) => Promise<CallToolResult>, request: PersonWaitRequest): Promise<CallToolResult> {
  let result = await attempt(false);
  let step = personStep(result);
  if (!step) return result;
  const deadline = Date.now() + waitMs;
  let progress = 0;
  const report = async (message: string): Promise<void> => {
    if (request.progressToken === undefined || !request.sendNotification || request.signal?.aborted) return;
    try {
      await request.sendNotification({ method: 'notifications/progress', params: { progressToken: request.progressToken, progress: ++progress, message } });
    } catch { /* Progress is optional; the tool result still carries the outcome. */ }
  };
  await report(`${step} Waiting for this automatically.`);
  while (Date.now() < deadline && !request.signal?.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now())));
      function done(): void { clearTimeout(timer); wakers.delete(done); request.signal?.removeEventListener('abort', done); resolve(); }
      wakers.add(done);
      request.signal?.addEventListener('abort', done, { once: true });
    });
    if (request.signal?.aborted) break;
    result = await attempt(true);
    const next = personStep(result);
    if (!next) return result;
    // Approving the app can uncover the site gate; say what is awaited now.
    if (next !== step) await report(`${next} Waiting for this automatically.`);
    step = next;
  }
  return { ...result, content: [...result.content, { type: 'text', text: STILL_WAITING }] };
}
