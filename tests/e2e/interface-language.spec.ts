import { expect, test } from '@playwright/test';

test('interface language switches independently and survives a reload', async ({ page }) => {
  await page.goto('/');
  const english = page.getByTestId('ui-language-en');
  const chinese = page.getByTestId('ui-language-zh');
  const heading = page.locator('.page-heading h1');

  await expect(heading).toHaveText('Documents');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(english).toHaveAttribute('aria-pressed', 'true');
  await expect(chinese).toHaveAttribute('aria-pressed', 'false');

  await chinese.click();
  await expect(heading).toHaveText('文档');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(chinese).toHaveAttribute('aria-pressed', 'true');
  await expect(english).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('oit.interface-language.v1'))).toBeTruthy();

  await page.reload();
  await expect(heading).toHaveText('文档');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(chinese).toHaveAttribute('aria-pressed', 'true');

  await english.click();
  await expect(heading).toHaveText('Documents');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(english).toHaveAttribute('aria-pressed', 'true');
  await expect(chinese).toHaveAttribute('aria-pressed', 'false');
});

test('interface language controls stay visible without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const english = page.getByTestId('ui-language-en');
  const chinese = page.getByTestId('ui-language-zh');

  await expect(english).toBeVisible();
  await expect(chinese).toBeVisible();
  await expect(english).toBeInViewport();
  await expect(chinese).toBeInViewport();
  await chinese.click();
  await expect(page.locator('.page-heading h1')).toHaveText('文档');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(english).toBeInViewport();
  await expect(chinese).toBeInViewport();

  await english.click();
  await expect(page.locator('.page-heading h1')).toHaveText('Documents');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('changing interface language preserves document, target, translations and an unsaved edit', async ({ page }) => {
  const translationPosts: string[] = [];
  const editWrites: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (/^\/api\/documents\/[^/]+\/translate$/.test(path) || path === '/api/translation-jobs' || path === '/api/translate')) translationPosts.push(path);
    if (request.method() === 'PATCH' && /^\/api\/documents\/[^/]+\/blocks\//.test(path)) editWrites.push(path);
  });
  await page.goto('/');
  const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/documents');
  await page.getByLabel('Import document', { exact: true }).setInputFiles({
    name: 'interface-language-notes.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# Original research notes\n\nOriginal prose about scientific reading and reproducible tools.\n\nKeep $E=mc^2$ and `source_code()` unchanged.\n\n```js\nconst original = 42;\n```\n'),
  });
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBe(true);
  const { document } = await uploadResponse.json() as { document: { id: string } };
  await expect(page.getByRole('heading', { name: 'interface-language-notes.md' })).toBeVisible();

  const target = page.locator('.language-group select');
  await target.selectOption('es');
  await expect(target).toHaveValue('es');
  const translate = page.getByRole('button', { name: 'Translate document', exact: true });
  await expect(translate).toBeEnabled();
  await translate.click();
  await expect(page.getByText('Translation complete. You can edit any translated paragraph before exporting.', { exact: true })).toBeVisible();
  await expect(page.locator('.translated-content')).toHaveCount(3);
  const originalSource = await page.locator('.source-content').allTextContents();
  const originalTranslations = await page.locator('.translated-content').allTextContents();
  const savedResponse = await page.request.get(`/api/documents/${document.id}?targetLanguage=es`);
  expect(savedResponse.ok()).toBe(true);
  const savedBefore = await savedResponse.json();
  expect(translationPosts).toHaveLength(1);

  await page.locator('.reading-block.block-paragraph .edit-block-button').first().click();
  const draft = page.locator('.edit-area textarea');
  const unsaved = 'UNSAVED DRAFT — keep this wording while changing the interface.';
  await draft.fill(unsaved);

  await page.getByTestId('ui-language-zh').click();
  await expect(page.locator('.page-heading h1')).toHaveText('文档');
  await expect(target).toHaveValue('es');
  await expect(draft).toHaveValue(unsaved);
  await expect(page.locator('.source-content')).toHaveText(originalSource);
  await expect(page.locator('.translated-content')).toHaveCount(3);

  await page.getByTestId('ui-language-en').click();
  await expect(page.locator('.page-heading h1')).toHaveText('Documents');
  await expect(draft).toHaveValue(unsaved);
  await expect(target).toHaveValue('es');
  await page.locator('.edit-area').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.source-content')).toHaveText(originalSource);
  await expect(page.locator('.translated-content')).toHaveText(originalTranslations);

  const afterResponse = await page.request.get(`/api/documents/${document.id}?targetLanguage=es`);
  expect(afterResponse.ok()).toBe(true);
  const savedAfter = await afterResponse.json();
  expect(savedAfter.document.blocks).toEqual(savedBefore.document.blocks);
  expect(savedAfter.translations).toEqual(savedBefore.translations);
  expect(translationPosts).toHaveLength(1);
  expect(editWrites).toHaveLength(0);
});
