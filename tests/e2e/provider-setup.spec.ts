import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

type Active = { kind: string; model: string; configured: boolean };
/** Shows the app as if the server ran this service, without contacting a real provider. */
async function pretendService(page: Page, active: Active, keys: { google?: boolean } = {}) {
  await page.route('**/api/health', route => route.fulfill({ json: { ok: true, version: '0.1.0', provider: active } }));
  await page.route('**/api/settings', route => route.fulfill({ json: { active, source: 'environment', provider: {
    kind: active.kind, ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:2b' },
    compatible: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', hasApiKey: false },
    google: { hasApiKey: !!keys.google }, codex: { model: 'gpt-6.1-sol' },
  } } }));
}

test.afterEach(async ({ request }) => { await request.delete('/api/settings/provider'); });

test('services are listed in both interface languages with the active one selected', async ({ page }) => {
  await pretendService(page, { kind: 'google', model: 'nmt', configured: true }, { google: true });
  await page.goto('/');
  await expect(page.locator('.provider-card')).toContainText('Google Cloud Translation');
  await page.locator('.provider-card').click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Translation service' })).toBeVisible();
  await expect(dialog.getByRole('radio')).toHaveCount(5);
  await expect(dialog.getByRole('radio', { name: /Google Cloud Translation/ })).toBeChecked();
  await expect(dialog).toContainText('Needs a Google Cloud API key');
  await expect(dialog.getByRole('link', { name: 'Google Cloud setup guide' })).toHaveAttribute('href', 'https://docs.cloud.google.com/translate/docs/setup');
  // A saved key is never sent back to the page; the field only says one exists.
  const key = dialog.getByLabel('API key');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', 'Saved. Leave blank to keep it.');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByTestId('ui-language-zh').click();
  await expect(page.locator('.provider-card')).toContainText('Google 云翻译');
  await page.locator('.provider-card').click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '翻译服务' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Google 云翻译/ })).toBeChecked();
  await expect(dialog.getByRole('link', { name: 'Google Cloud 配置指南' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
});

test('a missing Google API key leaves document import available and translation disabled', async ({ page }) => {
  await pretendService(page, { kind: 'google', model: 'nmt', configured: false });
  await page.goto('/');
  await page.getByLabel('Import document', { exact: true }).setInputFiles({
    name: 'google-provider-setup.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Provider setup\n\nThis source remains readable before a translation provider is configured.\n'),
  });
  await expect(page.getByRole('heading', { name: 'google-provider-setup.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Translate document', exact: true })).toBeDisabled();
  await expect(page.locator('.source-content')).toContainText(['Provider setup', 'This source remains readable']);
  await page.locator('.provider-card').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('status').first()).toHaveText('This service is not fully set up yet.');
  await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', '');
});

test('the free Google service is identified as unofficial, and Codex setup still offers the agent request', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedSetup: string }).copiedSetup = text; },
    } });
  });
  await pretendService(page, { kind: 'codex', model: 'gpt-6.1-sol', configured: true });
  await page.goto('/');
  await expect(page.locator('.provider-card')).toContainText('Codex translation');
  await expect(page.locator('.provider-card')).toContainText('gpt-6.1-sol');
  await page.locator('.provider-card').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: /Codex translation/ })).toBeChecked();
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('gpt-6.1-sol');
  await expect(dialog).toContainText('Uses the Codex CLI already signed in on this computer.');
  await dialog.getByRole('radio', { name: /Google Translate · free web/ }).check();
  await expect(dialog).toContainText('No key needed. Text goes to an unofficial Google endpoint that may be throttled.');
  await expect(dialog.locator('.field')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
  await expect(dialog.locator('.agent-copy-status')).toContainText('Copied');
  const copied = await page.evaluate(() => (window as unknown as { copiedSetup: string }).copiedSetup);
  expect(copied).toContain('TRANSLATION_PROVIDER=google-free');
  expect(copied).toContain('unofficial and potentially throttled');
  expect(copied).toContain('Do not use Codex as the translation backend unless I explicitly request it');

  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByTestId('ui-language-zh').click();
  await expect(page.locator('.provider-card')).toContainText('Codex 翻译');
  await page.locator('.provider-card').click();
  await page.getByRole('dialog').getByRole('radio', { name: /Google 翻译 · 免费网页接口/ }).check();
  await expect(page.getByRole('dialog')).toContainText('非官方接口');
});

test('switching service in the app takes effect at once, survives a reload, and hides the key', async ({ page }) => {
  // A stand-in OpenAI-compatible service that records the credentials sent with translations.
  const authorizations: Array<string | undefined> = [];
  const service = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      // The model list is requested as soon as the address is typed, before any key exists.
      if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'paper-model' }] })); return; }
      authorizations.push(request.headers.authorization);
      const input = JSON.parse(JSON.parse(body).messages[1].content) as { segments: Array<{ id: string; text: string }> };
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: input.segments.map(segment => ({ id: segment.id, text: `[Stand-in] ${segment.text}` })) }) } }] }));
    });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const settingsBodies: string[] = [];
  page.on('response', async response => { if (new URL(response.url()).pathname.startsWith('/api/settings')) settingsBodies.push(await response.text().catch(() => '')); });
  try {
    await page.goto('/');
    await expect(page.getByText('Demo mode is active.')).toBeVisible();
    await page.locator('.provider-card').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await dialog.getByRole('radio', { name: /OpenAI-compatible API/ }).check();
    await dialog.getByLabel('Server URL').fill(`http://127.0.0.1:${(service.address() as AddressInfo).port}/v1`);
    await dialog.getByLabel('API key').fill('e2e-dummy-key');
    await expect(dialog.locator('datalist option')).toHaveCount(1);
    await dialog.getByLabel('Model', { exact: true }).fill('paper-model');

    await dialog.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(dialog.locator('.service-status')).toHaveText('Works: [Stand-in] Open tools make research reproducible.');
    await expect(page.getByText('Demo mode is active.')).toBeVisible();

    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator('.service-status')).toHaveText('Saved. New translations use this service.');
    await expect(page.getByText('Demo mode is active.')).toHaveCount(0);
    await expect(page.locator('.provider-card')).toContainText('OpenAI-compatible API');
    await expect(page.locator('.provider-card')).toContainText('paper-model');
    await expect(dialog.getByLabel('API key')).toHaveValue('');
    await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved. Leave blank to keep it.');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

    await page.getByLabel('Import document', { exact: true }).setInputFiles({
      name: 'switch-service.md', mimeType: 'text/markdown', buffer: Buffer.from('# Switching\n\nTranslated by the selected service.\n'),
    });
    await page.getByRole('button', { name: 'Translate document', exact: true }).click();
    await expect(page.locator('.translated-content')).toHaveText(['[Stand-in] Switching', '[Stand-in] Translated by the selected service.']);
    expect(authorizations.length).toBeGreaterThanOrEqual(2);
    expect(authorizations.every(value => value === 'Bearer e2e-dummy-key')).toBe(true);

    await page.reload();
    await expect(page.locator('.provider-card')).toContainText('OpenAI-compatible API');
    await page.locator('.provider-card').click();
    await expect(page.getByRole('dialog').getByRole('radio', { name: /OpenAI-compatible API/ })).toBeChecked();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove key', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Remove key', exact: true })).toHaveCount(0);
    expect(settingsBodies.length).toBeGreaterThan(3);
    expect(settingsBodies.some(body => body.includes('e2e-dummy-key'))).toBe(false);
    expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain('e2e-dummy-key');
  } finally { await new Promise<void>(resolve => service.close(() => resolve())); }
});
