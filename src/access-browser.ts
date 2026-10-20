/** A temporary loopback email form for clients that cannot display elicitation. */
import { createHash, randomBytes } from 'node:crypto';
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

// Native form submission still works without JavaScript. This only provides
// immediate feedback; the server also deduplicates concurrent submissions.
const FORM_SCRIPT = `
const form = document.querySelector('form');
if (form) {
  const button = form.querySelector('button');
  const email = form.querySelector('[name="email"]');
  const status = document.getElementById('verification-status');
  const originalStatus = status.textContent;
  let sending = false;
  form.addEventListener('submit', (event) => {
    if (sending) { event.preventDefault(); return; }
    sending = true;
    button.disabled = true;
    button.textContent = 'Sending…';
    email.readOnly = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Sending your sign-in link…';
  });
  window.addEventListener('pageshow', () => {
    sending = false;
    button.disabled = false;
    button.textContent = 'Send verification link';
    email.readOnly = false;
    form.removeAttribute('aria-busy');
    status.textContent = originalStatus;
  });
}
`;
const FORM_SCRIPT_HASH = createHash('sha256').update(FORM_SCRIPT).digest('base64');

function page(path: string, csrf: string, message: string, sent: boolean): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify your email | MCP Browser Extension</title>
<style>
  /* Match the extension popup's existing light/dark theme. */
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
    --bg:#ffffff;--panel:#f6f7f9;--fg:#0f172a;--muted:#64748b;--line:#e6e8ec;
    --accent:oklch(0.58 0.19 255);--accent-foreground:oklch(0.99 0 0);--ring:oklch(0.58 0.19 255 / 35%)}
  @media(prefers-color-scheme:dark){:root{--bg:#0b0d12;--panel:#11141b;--fg:#e8ebf2;--muted:#8b93a7;--line:#232836;
    --accent:oklch(0.7 0.16 255);--accent-foreground:oklch(0.12 0.02 255);--ring:oklch(0.7 0.16 255 / 45%)}}
  *{box-sizing:border-box}
  body{max-width:488px;margin:12vh auto;padding:24px;background:var(--bg);color:var(--fg);line-height:1.5;-webkit-font-smoothing:antialiased}
  h1{font-size:28px;line-height:1.2;font-weight:500;letter-spacing:-0.025em}
  label{display:block;font-weight:500}
  input,button{width:100%;font:inherit;padding:12px;margin-top:8px;border:1px solid var(--line);border-radius:9px}
  input{background:var(--panel);color:var(--fg)}
  input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px;box-shadow:0 0 0 4px var(--ring)}
  button{margin-top:18px;background:var(--accent);color:var(--accent-foreground);border-color:transparent;font-weight:500;cursor:pointer}
  button:hover:not(:disabled){background:color-mix(in oklch,var(--accent) 88%,var(--fg))}
  button:disabled{cursor:wait}
  p{margin:20px 0;color:var(--muted)} .brand{font-size:14px;color:var(--fg)}
  small{display:block;margin-top:18px;color:var(--muted)}
</style>
<body><p class="brand">MCP Browser Extension</p><h1>${sent ? 'Check your inbox' : 'Verify your email'}</h1>
<p id="verification-status" role="status">${escapeHtml(message)}</p>
${sent ? '<p>After opening the sign-in link, return to your assistant to continue.</p>' : `
<form method="post" action="${path}">
  <input type="hidden" name="csrf" value="${csrf}">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="email" maxlength="254" required autofocus>
  <button type="submit">Send verification link</button>
</form><small>Your email is sent to mcp-browser-extension.com to verify and manage access.</small>
<script>${FORM_SCRIPT}</script>`}
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
  let sending: Promise<EmailSubmission> | undefined;
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
      'content-security-policy': `default-src 'none'; script-src 'sha256-${FORM_SCRIPT_HASH}'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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
        // A reload during delivery must wait for the same result instead of
        // restoring an email-entry form that is already being submitted.
        const outcome = sending ? await sending : undefined;
        respond(res, 200, sent ? sentMessage : outcome?.message ?? 'Enter your email below. We will send you a one-time sign-in link.');
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
      if (!sending) {
        // A repeated click replaces the browser's pending navigation. Share
        // its result so the latest page shows the outcome of the one email.
        sending = Promise.resolve()
          .then(() => submit(fields.get('email') ?? ''))
          .then((outcome) => { sent = outcome.ok; return outcome; })
          .finally(() => { sending = undefined; });
      }
      const outcome = await sending;
      respond(res, outcome.ok ? 200 : 400, outcome.ok ? sentMessage : outcome.message);
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
