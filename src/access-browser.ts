/** A temporary loopback email form for clients that cannot display elicitation. */
import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

export interface BrowserEmailPrompt {
  url: string;
  close(): void;
}

export interface EmailSubmission { ok: boolean; message: string }

/** Best effort: the tool also returns the link for remote/headless computers. */
export function openBrowserEmailPrompt(url: string): void {
  // Only launch a form we host, never a URL received from an MCP request.
  if (!/^http:\/\/127\.0\.0\.1:\d+\/verify\/[a-f0-9]{64}$/.test(url)) return;
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* The displayed link remains usable if no browser is available. */ });
    child.unref();
  } catch { /* Keep the form available even if the operating system cannot open it. */ }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(path: string, csrf: string, message: string, sent: boolean): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify your email | MCP Browser Extension</title>
<style>
  :root{color-scheme:light dark;font-family:system-ui,sans-serif}
  body{max-width:440px;margin:12vh auto;padding:24px;line-height:1.5}
  h1{font-size:28px;line-height:1.2} label{display:block;font-weight:600}
  input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:8px;border:1px solid #888;border-radius:6px}
  button{margin-top:18px;background:#175cd3;color:white;border-color:#175cd3;cursor:pointer}
  p{margin:20px 0} .brand{font-size:14px} small{display:block;margin-top:18px}
</style>
<body><p class="brand">MCP Browser Extension</p><h1>${sent ? 'Check your inbox' : 'Verify your email'}</h1>
<p role="status">${escapeHtml(message)}</p>
${sent ? '<p>After opening the sign-in link, return to your assistant to continue.</p>' : `
<form method="post" action="${path}">
  <input type="hidden" name="csrf" value="${csrf}">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="email" maxlength="254" required autofocus>
  <button type="submit">Send verification link</button>
</form><small>Your email is sent to mcp-browser-extension.com to verify and manage access.</small>`}
</body></html>`;
}

/** Only the person submitting this form can start an email. GET never sends one. */
export async function createBrowserEmailPrompt(
  submit: (email: string) => Promise<EmailSubmission>,
  options: { onClose?: () => void; ttlMs?: number } = {},
): Promise<BrowserEmailPrompt> {
  const path = `/verify/${randomBytes(32).toString('hex')}`;
  const csrf = randomBytes(32).toString('hex');
  let origin = '';
  let sent = false;
  let busy = false;
  let closed = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const sentMessage = 'A sign-in link has been sent. Open it from your email and click Verify this device to finish verification.';
  const respond = (res: ServerResponse, status: number, message: string): void => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Keep Origin on same-origin form POSTs; no-referrer makes Chromium send
      // Origin: null. Cross-origin destinations still receive no referrer.
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(page(path, csrf, message, sent));
  };
  const server = createServer((req, res) => {
    void (async () => {
      // Exact Host + Origin checks also prevent DNS rebinding and cross-site
      // submissions. The random path is independent of every device credential.
      if (req.headers.host !== origin.slice('http://'.length) || req.url !== path) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET') {
        respond(res, 200, sent ? sentMessage : 'Enter your email below. We will send you a one-time sign-in link.');
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }).end(); return; }
      if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        res.writeHead(415).end();
        return;
      }
      let body = '';
      let bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2048) { res.writeHead(413).end(); return; }
        body += chunk.toString();
      }
      const fields = new URLSearchParams(body);
      if (fields.get('csrf') !== csrf) { res.writeHead(403).end(); return; }
      if (sent) { respond(res, 200, sentMessage); return; }
      if (busy) { respond(res, 409, 'Your request is already being sent. Please wait.'); return; }
      busy = true;
      try {
        const outcome = await submit(fields.get('email') ?? '');
        sent = outcome.ok;
        respond(res, outcome.ok ? 200 : 400, outcome.ok ? sentMessage : outcome.message);
      } finally {
        busy = false;
      }
    })().catch(() => { if (!res.headersSent) respond(res, 503, 'The verification service could not be reached. Please try again.'); });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    server.close();
    server.closeAllConnections();
    options.onClose?.();
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { close(); throw new Error('No loopback address'); }
  origin = `http://127.0.0.1:${address.port}`;
  expiry = setTimeout(close, options.ttlMs ?? 10 * 60_000);
  expiry.unref();
  server.unref();
  return { url: origin + path, close };
}
