import { expect, test } from '@playwright/test';

test('import, translate, edit, persist and export a bilingual document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Translate websites' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.locator('.provider-card').click();
  await expect(page.getByRole('heading', { name: 'Translation provider' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noOverflow).toBe(true);
});

test('library lists server documents and deletes the open one after confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Import document', { exact: true }).setInputFiles({
    name: 'to-delete.md', mimeType: 'text/markdown', buffer: Buffer.from('# Temporary\n\nThis document will be deleted.\n'),
  });
  await expect(page.getByRole('heading', { name: 'to-delete.md' })).toBeVisible();
  const item = page.locator('.library-item', { hasText: 'to-delete.md' });
  await expect(item).toHaveCount(1);

  page.once('dialog', dialog => dialog.dismiss());
  await item.getByRole('button', { name: 'Delete to-delete.md', exact: true }).click();
  await expect(item).toHaveCount(1);

  page.once('dialog', dialog => dialog.accept());
  await item.getByRole('button', { name: 'Delete to-delete.md', exact: true }).click();
  await expect(item).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Drop a document here' })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('document')).toBe(false);
  await page.reload();
  await expect(page.locator('.library-item', { hasText: 'to-delete.md' })).toHaveCount(0);
});

test('papers render math with KaTeX and translate table cells beside their source', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Import document', { exact: true }).setInputFiles({
    name: 'paper-elements.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Results\n\nEach context has length $k = \\lceil L/l \\rceil$ tokens.\n\n| Model | Context type |\n|---|---|\n| SantaCoder | prior |\n'),
  });
  await expect(page.getByRole('heading', { name: 'paper-elements.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Translate document', exact: true }).click();
  await expect(page.getByText('Translation complete.', { exact: false })).toBeVisible();
  await expect(page.locator('.block-paragraph .source-content .katex')).toHaveCount(1);
  await expect(page.locator('.block-paragraph .translated-content .katex')).toHaveCount(1);
  const table = page.locator('.block-table table');
  await expect(table).toHaveCount(1);
  await expect(table.locator('.cell-translation')).toHaveText(['[Demo · zh-Hans] Model', '[Demo · zh-Hans] Context type', '[Demo · zh-Hans] prior']);
  await expect(table.locator('td').first()).toHaveText('SantaCoder');
});
