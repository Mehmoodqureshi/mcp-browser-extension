import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createBrowserEmailPrompt } from '../../src/access-browser';

test('the fallback email form works in Chromium with native form submission', {
  skip: !process.env.RUN_E2E,
}, async () => {
  const submissions: string[] = [];
  const prompt = await createBrowserEmailPrompt(async (email) => {
    submissions.push(email);
    return submissions.length === 1
      ? { ok: false, message: 'The verification service could not be reached. Please try again.' }
      : { ok: true, message: '' };
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(prompt.url);
    assert.equal(await page.title(), 'Verify your email | MCP Browser Extension');
    assert.equal(await page.getByRole('heading', { name: 'Verify your email' }).count(), 1);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const email = page.getByLabel('Email address');
    const send = page.getByRole('button', { name: 'Send verification link' });
    await send.click();
    assert.equal(await email.evaluate((el: HTMLInputElement) => el.validity.valueMissing), true);
    await email.fill('invalid');
    await send.click();
    assert.equal(await email.evaluate((el: HTMLInputElement) => el.validity.typeMismatch), true);
    assert.deepEqual(submissions, [], 'opening the page or submitting invalid input cannot send an email');

    await email.fill('user@example.com');
    const [failed] = await Promise.all([page.waitForNavigation(), send.click()]);
    assert.equal(failed?.status(), 400);
    assert.match(await page.getByRole('status').innerText(), /could not be reached/);
    await email.fill('user@example.com');
    const [sent] = await Promise.all([page.waitForNavigation(), send.click()]);
    assert.equal(sent?.status(), 200);
    assert.equal(await page.getByRole('heading', { name: 'Check your inbox' }).count(), 1);
    assert.equal(await email.count(), 0);
    assert.deepEqual(submissions, ['user@example.com', 'user@example.com']);
    await page.goto(prompt.url);
    assert.equal(await page.getByRole('heading', { name: 'Check your inbox' }).count(), 1);
    assert.equal(submissions.length, 2, 'reopening the page does not send again');
  } finally {
    await browser.close();
    prompt.close();
  }
});

test('a repeated click during a slow email send ends on Check your inbox without a refresh', {
  skip: !process.env.RUN_E2E,
}, async () => {
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
  const browser = await chromium.launch({ headless: true });
  try {
    // The server must still deduplicate submissions when JavaScript is off.
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.goto(prompt.url);
    await page.getByLabel('Email address').fill('user@example.com');
    const send = page.getByRole('button', { name: 'Send verification link' });
    const bounds = await send.boundingBox();
    assert.ok(bounds);
    const click = () => page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await click();
    await sending;
    const nextPost = page.waitForRequest((request) => request.url() === prompt.url && request.method() === 'POST');
    await click();
    await nextPost;
    // Keep the first request pending long enough for the repeated click to
    // reach the form handler. Only one email may be sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish();
    // Chromium may abort either duplicate navigation. Assert the final page
    // the person sees, regardless of which response it keeps.
    await page.getByRole('heading', { name: 'Check your inbox' }).waitFor();
    assert.equal(submissions, 1);
    assert.equal(await page.getByRole('heading', { name: 'Check your inbox' }).count(), 1);
    assert.equal(await page.getByLabel('Email address').count(), 0);
  } finally {
    finish();
    await browser.close();
    prompt.close();
  }
});

test('the sending button blocks repeated clicks and resets after a failed send', {
  skip: !process.env.RUN_E2E,
}, async () => {
  let started!: () => void;
  let finish!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  const submissions: string[] = [];
  const prompt = await createBrowserEmailPrompt(async (email) => {
    submissions.push(email);
    if (submissions.length > 1) return { ok: true, message: '' };
    started();
    await release;
    return { ok: false, message: 'Please try again.' };
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    type SubmitState = { label: string; disabled: boolean; busy: string | null; message: string };
    let capture!: (value: SubmitState) => void;
    const submittedState = new Promise<SubmitState>((resolve) => { capture = resolve; });
    await page.exposeFunction('captureSubmission', capture);
    await page.goto(prompt.url);
    await page.evaluate(() => {
      // Observe the state after the form's submit listener, before native
      // navigation starts. Do not change or intercept the submission.
      document.addEventListener('submit', () => {
        const button = document.querySelector('button')!;
        const report = (window as unknown as { captureSubmission(value: unknown): Promise<void> }).captureSubmission;
        void report({
          label: button.textContent,
          disabled: button.disabled,
          busy: document.querySelector('form')!.getAttribute('aria-busy'),
          message: document.querySelector('[role="status"]')!.textContent,
        }).catch(() => undefined);
      });
    });
    await page.getByLabel('Email address').fill('user@example.com');
    const button = page.getByRole('button');
    const bounds = await button.boundingBox();
    assert.ok(bounds);
    const click = () => page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const failedResponse = page.waitForResponse((response) =>
      response.url() === prompt.url && response.request().method() === 'POST');
    await click();
    await sending;
    assert.deepEqual(await submittedState, {
      label: 'Sending…', disabled: true, busy: 'true', message: 'Sending your sign-in link…',
    });
    await click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(submissions, ['user@example.com']);
    finish();
    assert.equal((await failedResponse).status(), 400);
    await page.getByRole('button', { name: 'Send verification link' }).waitFor();
    assert.equal(await button.isEnabled(), true);
    assert.equal(await page.getByLabel('Email address').isEditable(), true);
    await page.getByLabel('Email address').fill('user@example.com');
    await Promise.all([page.waitForNavigation(), button.click()]);
    assert.equal(await page.getByRole('heading', { name: 'Check your inbox' }).count(), 1);
    assert.equal(submissions.length, 2);
  } finally {
    finish();
    await browser.close();
    prompt.close();
  }
});
