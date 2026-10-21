import { expect, test } from '@playwright/test';

test('import, translate, edit, persist and export a bilingual document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Document translation.' })).toBeVisible();
  await expect(page.getByText('Demo mode is active.')).toBeVisible();

  await page.getByLabel('Import document', { exact: true }).setInputFiles({
    name: 'reading-notes.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Reading across languages\n\nA paragraph about open scientific tools and reproducible research.\n\nKeep the formula $E=mc^2$ and `code()` intact.\n\n```js\nconst untouched = 42;\n```\n'),
  });
  await expect(page.getByRole('heading', { name: 'reading-notes.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Translate document', exact: true }).click();
  await expect(page.getByText('Translation complete. You can edit any translated paragraph before exporting.')).toBeVisible();
  await expect(page.locator('.translated-content').first()).toContainText('[Demo');
  await expect(page.locator('.block-code')).toContainText('const untouched = 42;');
  await expect(page.locator('.block-code .translated-content')).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit translation for block 2', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit translation for block 2', exact: true }).fill('人工编辑：开放工具促进可复现研究。');
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await expect(page.locator('.translated-content')).toContainText(['[Demo', '人工编辑：开放工具促进可复现研究。']);

  await page.reload();
  await expect(page.getByText('人工编辑：开放工具促进可复现研究。', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'HTML', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/reading-notes-zh-Hans\.html$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(path!, 'utf8');
  expect(html).toContain('人工编辑');
  expect(html).toContain('E=mc^2');
  expect(html).not.toContain('<script');

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.paper')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile layout, settings and language changes remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.getByRole('button', { name: 'Website translation', exact: false }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Translate the web, too.' })).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.locator('.provider-card').click();
  await expect(page.getByRole('heading', { name: 'A provider of your own.' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noOverflow).toBe(true);
});
