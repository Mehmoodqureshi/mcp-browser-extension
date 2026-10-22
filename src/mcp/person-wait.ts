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

let pollMs = 1_500;
// Stay under the 60 s default tool timeout some MCP clients enforce.
let waitMs = 45_000;

export function setPersonWaitForTesting(poll: number, wait: number): void {
  pollMs = Math.max(1, poll);
  waitMs = Math.max(1, wait);
}

const APPROVAL = /Please approve "/;
const SITE = /^\[POLICY_DENIED\] Please allow access to /;

/** The person-only step a result is blocked on, or undefined when it is not. */
export function personStep(result: CallToolResult): string | undefined {
  if (!result.isError) return undefined;
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return APPROVAL.test(text) || SITE.test(text) ? text : undefined;
}

export const STILL_WAITING =
  'Still waiting for the person. Call the same tool again to keep waiting; it continues on its own once they approve. ' +
  'Do not use shell sleeps or ask them to confirm in chat.';

/**
 * Run `attempt` until it is no longer blocked on the person, the wait expires,
 * or the call is cancelled. Only results that ran nothing (approval / site
 * gate refusals) are retried.
 */
export async function waitForPerson(attempt: () => Promise<CallToolResult>, request: PersonWaitRequest): Promise<CallToolResult> {
  let result = await attempt();
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
      function done(): void { clearTimeout(timer); request.signal?.removeEventListener('abort', done); resolve(); }
      request.signal?.addEventListener('abort', done, { once: true });
    });
    if (request.signal?.aborted) break;
    result = await attempt();
    const next = personStep(result);
    if (!next) return result;
    // Approving the app can uncover the site gate; say what is awaited now.
    if (next !== step) await report(`${next} Waiting for this automatically.`);
    step = next;
  }
  return { ...result, content: [...result.content, { type: 'text', text: STILL_WAITING }] };
}
