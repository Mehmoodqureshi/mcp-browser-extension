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
