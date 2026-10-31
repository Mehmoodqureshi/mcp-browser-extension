/**
 * extension/src/sw/observers.ts — registers (and unregisters) the MAIN-world
 * observer hook as a document_start content script.
 *
 * Why register rather than inject on demand: the interesting console output and
 * the interesting failed request both happen while the page loads. A hook
 * injected when the tool is first called has already missed them, and telling a
 * user "reload and try again" is a worse answer than being there from the start.
 *
 * Registration is driven entirely by the policy the server delivers: it happens
 * only when `allowObservers` is on, and only for the domains on the allowlist —
 * so a page the tool may not read is also a page the tool does not instrument.
 */

import { observerMatches } from '../../../shared/observers';
import type { WirePolicy } from '../../../shared/protocol';
import { initializeBrowserPermissions } from './browser-permissions';

const SCRIPT_ID = 'chrome-mcp-observers';
let updates: Promise<void> = Promise.resolve();

/** Bring the registered script in line with `policy`; never throws. */
export function syncObserverScript(policy: WirePolicy | null, log: (m: string) => void): Promise<void> {
  // A stop must win over a registration already waiting on Chrome.
  updates = updates.then(() => applyObserverScript(policy, log));
  return updates;
}

async function applyObserverScript(policy: WirePolicy | null, log: (m: string) => void): Promise<void> {
  try {
    await initializeBrowserPermissions();
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
    // Chrome does not consider two separate HTTP/HTTPS grants to contain one
    // wildcard-scheme pattern. Register the concrete granted schemes instead.
    // Automatic sites are checked on demand, before the executor installs a hook.
    const candidates = (policy && !policy.automaticSites ? observerMatches(policy) : []).flatMap((pattern) =>
      pattern.startsWith('*://') ? [`http${pattern.slice(1)}`, `https${pattern.slice(1)}`] : [pattern]);
    const checks = await Promise.all(candidates.map(async (pattern) =>
      await chrome.permissions.contains({ origins: [pattern] }) ? pattern : null));
    const wanted = checks.filter((pattern): pattern is string => pattern !== null);

    if (wanted.length === 0) {
      if (existing.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
        log('observers: unregistered (disabled by policy)');
      }
      return;
    }

    const spec: chrome.scripting.RegisteredContentScript = {
      id: SCRIPT_ID,
      js: ['page-hook.js'],
      matches: wanted,
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      persistAcrossSessions: false,
    };
    if (existing.length > 0) await chrome.scripting.updateContentScripts([spec]);
    else await chrome.scripting.registerContentScripts([spec]);
    log(`observers: registered for ${wanted.join(', ')}`);
  } catch (err) {
    // A failed registration is not fatal: the `observers` command injects the
    // hook on demand as a fallback, it just cannot see the page load.
    log(`observers: registration failed (${err instanceof Error ? err.message : String(err)})`);
  }
}
