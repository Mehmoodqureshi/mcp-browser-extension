// Startup, settings changes and keepalive can all request the identity together.
// Share its creation so the connection and storage always use the same ID.
let identity: Promise<string> | undefined;

export function ensureInstallId(): Promise<string> {
  return identity ??= (async () => {
    const { installId } = await chrome.storage.local.get('installId');
    if (typeof installId === 'string' && installId.length > 0) return installId;
    const fresh = crypto.randomUUID();
    await chrome.storage.local.set({ installId: fresh });
    return fresh;
  })().catch((err) => {
    identity = undefined;
    throw err;
  });
}
