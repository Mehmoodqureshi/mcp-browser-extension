import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createBrowserEmailPrompt } from '../src/access-browser';

test('browser email form rejects cross-site and malformed submissions, and escapes errors', async (t) => {
  const emails: string[] = [];
  const prompt = await createBrowserEmailPrompt(async (email) => {
    emails.push(email);
    return { ok: false, message: '<script>alert("error")</script>' };
  });
  t.after(() => prompt.close());
  const response = await fetch(prompt.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const html = await response.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const origin = new URL(prompt.url).origin;
  const post = (body: string, from = origin, contentType = 'application/x-www-form-urlencoded') => fetch(prompt.url, {
    method: 'POST', headers: { origin: from, 'content-type': contentType }, body,
  });
  const body = new URLSearchParams({ csrf, email: 'user@example.com' }).toString();
  assert.equal((await post(body, 'https://untrusted.example')).status, 403);
  assert.equal((await post(body, '')).status, 403);
  assert.equal((await post(body, origin, 'text/plain')).status, 415);
  assert.equal((await post('email=user%40example.com&csrf=wrong')).status, 403);
  assert.equal((await post('x'.repeat(3000))).status, 413);
  assert.equal((await fetch(origin + '/verify/wrong')).status, 404);
  assert.equal((await fetch(prompt.url, { method: 'PUT' })).status, 405);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(prompt.url, { headers: { host: 'untrusted.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHost, 404);
  assert.deepEqual(emails, [], 'rejected requests must never send email');
  const failed = await post(body);
  assert.equal(failed.status, 400);
  const errorHtml = await failed.text();
  assert.ok(errorHtml.includes('&lt;script&gt;'));
  assert.ok(!errorHtml.includes('<script>alert("error")</script>'));
  assert.deepEqual(emails, ['user@example.com']);
});

test('a temporary browser form expires and closes its listener', async () => {
  let closed = false;
  const prompt = await createBrowserEmailPrompt(async () => ({ ok: true, message: '' }), {
    ttlMs: 20, onClose: () => { closed = true; },
  });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closed, true);
    await assert.rejects(fetch(prompt.url));
  } finally {
    prompt.close();
  }
});

test('concurrent submissions and refreshes share the sent page without duplicate emails', async (t) => {
  let started!: () => void;
  let finish!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  let submissions = 0;
  const prompt = await createBrowserEmailPrompt(async () => {
    submissions++;
    started();
    await release;
    return { ok: true, message: '' };
  });
  t.after(() => { finish(); prompt.close(); });
  const html = await (await fetch(prompt.url)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const send = () => fetch(prompt.url, {
    method: 'POST', headers: { origin: new URL(prompt.url).origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, email: 'user@example.com' }),
  });
  const first = send();
  await sending;
  const repeated = send();
  const refreshed = fetch(prompt.url);
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish();
  for (const response of await Promise.all([first, repeated, refreshed])) {
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Check your inbox/);
    assert.doesNotMatch(html, /type="email"/);
  }
  assert.equal((await send()).status, 200);
  assert.equal(submissions, 1);
});
