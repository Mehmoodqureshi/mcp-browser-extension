/**
 * extension/src/connect.ts — the one-click Connect button.
 *
 * Asks the MCP Browser Extension server's native messaging helper (registered
 * with Chrome every time the server starts) for the port, token and profile,
 * saves them, and reconnects. The first click asks Chrome for the optional
 * nativeMessaging permission; after that the service worker can refetch a
 * rotated token by itself.
 */

/** Must match NATIVE_HOST_NAME on the server. */
export const NATIVE_HOST = 'com.mehmoodqureshi.mcp_browser_extension';

export type PairingReply =
  | { ok: true; port: number; token: string; profile?: string }
  | { ok: false; error?: string; message?: string };

/** Ask the helper for the pairing. Needs the nativeMessaging permission already granted. */
export async function fetchPairing(): Promise<PairingReply> {
  // Chrome adds this API to a running worker only after it restarts, so the
  // first click that grants nativeMessaging cannot use it yet.
  if (typeof chrome.runtime.sendNativeMessage !== 'function') {
    return { ok: false, error: 'restart_needed', message: 'Finishing setup. Click Connect again if this stays.' };
  }
  try {
    const reply = (await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'pairing' })) as PairingReply | undefined;
    return reply ?? { ok: false, message: 'The helper gave no answer.' };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // Chrome's wording when the host is not registered: the server never ran here.
    if (/not found|not registered|Specified native messaging host/i.test(why)) {
      return {
        ok: false,
        error: 'no_helper',
        message:
          'Add the MCP Browser Extension server to your AI client (Claude Code, Cursor…) and start it once; it sets this up. Then click Connect again.',
      };
    }
    return { ok: false, message: why };
  }
}

/** Save a pairing and have the service worker connect with it. */
export async function applyPairing(reply: Extract<PairingReply, { ok: true }>): Promise<void> {
  await chrome.storage.local.set({
    wsPort: reply.port,
    token: reply.token,
    // The server's own --profile, as a suggestion only: another browser may
    // already use that name, and taking it over would disconnect that one.
    suggestedProfile: reply.profile ?? '',
    pairingSource: 'native',
  });
}

/**
 * The button: ask for the permission (needs the click's user gesture), fetch
 * the pairing, save it, reconnect. Resolves with a message to show on failure.
 */
export async function connectWithOneClick(): Promise<{ ok: boolean; message?: string }> {
  try {
    return await chrome.runtime.sendMessage({ type: 'connect_with_click' }) ?? { ok: false, message: 'Could not reach the extension.' };
  } catch { return { ok: false, message: 'Could not reach the extension. Reopen the popup and try again.' }; }
}

/** The worker keeps the permission request and pairing alive after the popup closes. */
export async function requestPairingFromClick(): Promise<PairingReply> {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!granted) return { ok: false, message: 'Chrome needs that permission to fetch the pairing for you. You can also pair by hand in Settings.' };
  return fetchPairing();
}
