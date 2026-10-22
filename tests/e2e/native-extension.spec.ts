import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('native MV3 launcher recovers an offline backend and keeps translations inside body through root mutations', async ({ request }, testInfo) => {
  // This is a fresh automated Chromium profile with the actual unpacked extension.
  // It does not access or validate the user's installed Chrome extension/profile.
  const health = await (await request.get('/api/health')).json();
  expect(health.provider.kind).toBe('demo');
  const backendUrl = testInfo.project.use.baseURL!;
  const profile = await mkdtemp(join(tmpdir(), 'oit-native-e2e-'));
  const extensionPath = resolve('apps/extension/dist');
  const errors: string[] = [];
  const inputs: Array<{ id: string; text: string }> = [];
  let workerUrl = '';
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    context.on('weberror', event => { errors.push(event.error().message); });
    context.on('console', message => {
      if (message.type() === 'error' && message.location().url.startsWith('chrome-extension://')) errors.push(message.text());
    });
    context.on('request', outgoing => {
      if (outgoing.method() === 'POST' && outgoing.url() === `${backendUrl}/api/translation-jobs`) inputs.push(...outgoing.postDataJSON().segments);
    });
    let [worker] = context.serviceWorkers();
    worker ||= await context.waitForEvent('serviceworker');
    workerUrl = worker.url();
    expect(workerUrl).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
    await worker.evaluate(async backend => {
      await chrome.storage.local.set({ settings: { backendUrl: backend, readerUrl: backend, sourceLanguage: 'auto', targetLanguage: 'fr', theme: 'subtle' } });
    }, 'http://127.0.0.1:65534');
    const page = await context.newPage();
    await page.route('https://example.org/native-root-mutations', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Native fixture title</title></head><body>
      <main><h1>Reading content stays in the body</h1><p id="original">Read <a href="https://example.org/research">this research</a> and keep <code>npm test</code> unchanged.</p></main>
    </body></html>` }));
    await page.goto('https://example.org/native-root-mutations');
    const original = await page.locator('#original').innerHTML();
    const launcher = page.locator('[data-oit-launcher]');
    await expect(launcher).toHaveCount(1);
    await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
    expect(inputs).toHaveLength(0);
    await launcher.getByRole('button', { name: 'Translate this page', exact: true }).click();
    await expect(launcher.getByRole('status')).toContainText('translation service is offline');
    await expect(launcher.getByRole('button', { name: 'Retry page translation', exact: true })).toBeVisible();
    await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
    await expect(page.locator('[data-oit-pending="true"]')).toHaveCount(0);
    expect(inputs).toHaveLength(0);
    expect(await page.locator('#original').innerHTML()).toBe(original);
    await worker.evaluate(async backend => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings as Record<string, unknown>), backendUrl: backend, readerUrl: backend } });
    }, backendUrl);
    await launcher.getByRole('button', { name: 'Retry page translation', exact: true }).click();
    await expect(page.locator('#original + [data-oit-owned="translation"]')).toContainText('[Demo');

    // Portals/analytics can add direct root text or update head/title while the
    // translator observes the page. Neither root may become an after() target.
    await page.evaluate(() => {
      document.documentElement.append(document.createTextNode('ROOT_PORTAL_SENTINEL'));
      document.head.append(document.createTextNode('HEAD_PORTAL_SENTINEL'));
      document.title = 'HEAD_TITLE_SENTINEL';
      document.documentElement.classList.add('native-root-updated');
      const paragraph = document.createElement('p'); paragraph.id = 'dynamic-native';
      paragraph.textContent = 'New body content should still translate after document-root mutations.';
      document.querySelector('main')!.append(paragraph);
    });
    await expect(page.locator('#dynamic-native + [data-oit-owned="translation"]')).toContainText('[Demo');
    await expect(page.locator('[data-oit-pending="true"]')).toHaveCount(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('[data-oit-owned]')].every(element => document.body.contains(element)))).toBe(true);
    await expect(page.locator('head [data-oit-owned], html > [data-oit-owned]')).toHaveCount(0);
    expect(inputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(inputs)).not.toMatch(/ROOT_PORTAL_SENTINEL|HEAD_PORTAL_SENTINEL|HEAD_TITLE_SENTINEL/);
    await expect(page).toHaveTitle('HEAD_TITLE_SENTINEL');
    await expect(page.locator('#original + [data-oit-owned="translation"] a')).toHaveAttribute('href', 'https://example.org/research');
    await expect(page.locator('#original + [data-oit-owned="translation"] code')).toHaveText('npm test');
    expect(await page.locator('#original').innerHTML()).toBe(original);
    await launcher.getByRole('button', { name: 'Restore original page' }).click();
    await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
    await expect(launcher).toHaveCount(1);
    await expect(launcher.getByRole('button', { name: 'Translate this page', exact: true })).toBeVisible();
    expect(await page.locator('#original').innerHTML()).toBe(original);
    expect(errors).toEqual([]);
  } finally {
    await testInfo.attach('native-extension-diagnostics', { body: JSON.stringify({ extensionPath, workerUrl, errors, modelInputCount: inputs.length }, null, 2), contentType: 'application/json' });
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
