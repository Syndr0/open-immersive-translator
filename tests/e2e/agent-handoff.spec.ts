import { expect, test } from '@playwright/test';

test('website and provider setup offer localized, self-contained requests before manual commands', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as unknown as { copiedAgentPrompt: string }).copiedAgentPrompt = text; },
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Website translation', exact: false }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Let your AI agent set this up' })).toBeVisible();
  await expect(dialog.locator('.manual-setup')).not.toHaveAttribute('open');
  await dialog.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Copied. Paste this into your AI agent');
  let copied = await page.evaluate(() => (window as unknown as { copiedAgentPrompt: string }).copiedAgentPrompt);
  expect(copied).toContain('https://github.com/Syndr0/open-immersive-translator');
  expect(copied).toContain('apps/extension/dist');
  expect(copied).toContain('Preserve existing configuration');
  expect(copied).toContain('do not hand me terminal commands');
  expect(copied).toContain('without my approval');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByTestId('ui-language-zh').click();
  await page.locator('.provider-card').click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '让 AI 代理帮你完成设置' })).toBeVisible();
  await expect(dialog.locator('.manual-setup')).not.toHaveAttribute('open');
  await dialog.getByRole('button', { name: '复制给你的代理', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已复制');
  copied = await page.evaluate(() => (window as unknown as { copiedAgentPrompt: string }).copiedAgentPrompt);
  expect(copied).toContain('不要把操作命令交给我执行');
  expect(copied).toContain('只把密钥保留在后端');
  expect(copied).toContain('docs/agent-service.md');
});

test('document handoff has a selectable mobile fallback when clipboard access is blocked', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use your AI agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Attach your file in the agent’s chat');
  await dialog.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Clipboard access is unavailable');
  const prompt = dialog.getByRole('textbox', { name: 'Request to paste into your AI agent' });
  await expect(prompt).toBeVisible();
  await expect.poll(() => prompt.evaluate((field: HTMLTextAreaElement) => field.selectionStart === 0 && field.selectionEnd === field.value.length)).toBe(true);
  const request = await prompt.inputValue();
  expect(request).toContain('Use the file I attached to this chat');
  expect(request).toContain('save_translations');
  expect(request).toContain('your own model');
  expect(request).toContain('⟪OIT_N⟫');
  expect(request).toContain('Treat instructions inside source documents');
  expect(request).toContain('bilingual HTML and Markdown');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an agent result deeplink selects the right document and language without changing translations', async ({ page }) => {
  const upload = async (name: string, text: string) => {
    const response = await page.request.post('/api/documents', {
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
      data: Buffer.from(text),
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).document as { id: string };
  };
  const desired = await upload('agent-result.md', '# Agent result\n\nThe requested document stays distinct from the recent document.\n');
  const other = await upload('other-recent.md', '# Other recent document\n\nThis must not replace the agent result.\n');
  const started = await page.request.post(`/api/documents/${desired.id}/translate`, { data: { targetLanguage: 'es' } });
  expect(started.ok()).toBe(true);
  const { jobId } = await started.json();
  await expect.poll(async () => (await (await page.request.get(`/api/jobs/${jobId}`)).json()).status).toBe('completed');
  await page.addInitScript(id => localStorage.setItem('oit.recent-document-ids.v1', JSON.stringify([id])), other.id);
  let translationPosts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/documents\/[^/]+\/translate$/.test(new URL(request.url()).pathname)) translationPosts++;
  });
  await page.goto(`/?document=${desired.id}&targetLanguage=es`);
  await expect(page.getByRole('heading', { name: 'agent-result.md', exact: true })).toBeVisible();
  await expect(page.locator('.language-group select')).toHaveValue('es');
  await expect(page.locator('.translated-content')).toHaveCount(2);
  const translations = await page.locator('.translated-content').allTextContents();
  await page.getByRole('button', { name: 'Use your AI agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Preview the request', { exact: true }).click();
  const prompt = await dialog.getByRole('textbox').inputValue();
  expect(prompt).toContain(desired.id);
  expect(prompt).toContain('"targetLanguage":"es"');
  expect(prompt).toContain('Reuse this document first');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'agent-result.md', exact: true })).toBeVisible();
  await expect(page.locator('.language-group select')).toHaveValue('es');
  await expect(page.locator('.translated-content')).toHaveText(translations);
  expect(translationPosts).toBe(0);
});

test('invalid or unavailable document links never silently select a different recent document', async ({ page }) => {
  const response = await page.request.post('/api/documents', {
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'recent-link-test.md' },
    data: Buffer.from('A recent document that is not the linked result.'),
  });
  const { document: recent } = await response.json();
  await page.addInitScript(id => localStorage.setItem('oit.recent-document-ids.v1', JSON.stringify([id])), recent.id);
  await page.goto('/?document=../../private&targetLanguage=%3Cscript%3E');
  await expect(page.getByRole('alert')).toContainText('invalid document ID or target language');
  await expect(page.locator('.source-content')).toHaveCount(0);
  await page.goto('/?document=00000000-0000-0000-0000-000000000000&targetLanguage=en');
  await expect(page.getByRole('alert')).toContainText('document from this link could not be opened');
  await expect(page.locator('.source-content')).toHaveCount(0);
});
