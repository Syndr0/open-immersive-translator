import { expect, test } from '@playwright/test';

test('Google provider setup stays on the backend and is available in both interface languages', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({
    json: { ok: true, version: '0.1.0', provider: { kind: 'google', model: 'nmt', configured: true } },
  }));
  await page.goto('/');
  await expect(page.locator('.provider-card')).toContainText('Google Cloud Translation');
  await page.locator('.provider-card').click();
  let dialog = page.getByRole('dialog');
  await dialog.locator('.manual-setup > summary').click();
  await expect(dialog).toContainText('Enable the Cloud Translation API (Basic v2) and billing');
  await expect(dialog).toContainText('TRANSLATION_PROVIDER=google');
  await expect(dialog).toContainText('GOOGLE_TRANSLATE_API_KEY=your-google-cloud-api-key');
  await expect(dialog).toContainText('The key stays on the backend');
  await expect(dialog).toContainText('ollama pull qwen3.5:2b');
  await expect(dialog).not.toContainText('qwen3.5:9b');
  await expect(dialog.locator('input')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Google Cloud setup guide' })).toHaveAttribute('href', 'https://docs.cloud.google.com/translate/docs/setup');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByTestId('ui-language-zh').click();
  await expect(page.locator('.provider-card')).toContainText('Google 云翻译');
  await page.locator('.provider-card').click();
  dialog = page.getByRole('dialog');
  await dialog.locator('.manual-setup > summary').click();
  await expect(dialog).toContainText('启用 Cloud Translation API（Basic v2）和结算');
  await expect(dialog).toContainText('密钥只保留在后端');
  await expect(dialog).toContainText('翻译质量取决于所选模型');
  await expect(dialog.locator('input')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Google Cloud 配置指南' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const done = dialog.getByRole('button', { name: '知道了', exact: true });
  await done.scrollIntoViewIfNeeded();
  await expect(done).toBeInViewport();
});

test('a missing Google API key leaves document import available and translation disabled', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({
    json: { ok: true, version: '0.1.0', provider: { kind: 'google', model: 'nmt', configured: false } },
  }));
  await page.goto('/');
  await page.getByLabel('Import document', { exact: true }).setInputFiles({
    name: 'google-provider-setup.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Provider setup\n\nThis source remains readable before a translation provider is configured.\n'),
  });
  await expect(page.getByRole('heading', { name: 'google-provider-setup.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Translate document', exact: true })).toBeDisabled();
  await expect(page.locator('.source-content')).toContainText(['Provider setup', 'This source remains readable']);
  await page.locator('.provider-card').click();
  await expect(page.getByRole('dialog')).toContainText('Provider configuration incomplete');
  await expect(page.getByRole('dialog').locator('input')).toHaveCount(0);
});
