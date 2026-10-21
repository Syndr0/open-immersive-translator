import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('built extension popup and settings offer agent setup with a clipboard fallback', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { chrome: unknown; copiedPrompt?: string; blockCopy?: boolean };
    state.chrome = {
      tabs: { query: async () => [{ id: 1 }] },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: {
        openOptionsPage: async () => {},
        sendMessage: async (message: { type: string }) => message.type === 'oit:health'
          ? { error: 'The local service is unavailable' }
          : message.type === 'oit:tab-status' ? { state: 'idle' } : {},
      },
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (state.blockCopy) throw new DOMException('Blocked', 'NotAllowedError');
        state.copiedPrompt = text;
      },
    } });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/ui.css', async route => route.fulfill({ contentType: 'text/css', body: await readFile(resolve('apps/extension/dist/ui.css'), 'utf8') }));
  for (const name of ['popup', 'options']) {
    const html = (await readFile(resolve(`apps/extension/dist/${name}.html`), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    await page.route(`**/extension-${name}-fixture`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`/extension-${name}-fixture`);
    await page.addScriptTag({ path: resolve(`apps/extension/dist/${name}.js`) });
    if (name === 'popup') await expect(page.locator('#connection')).toContainText('Copy for your agent');
    else await expect(page.locator('.manual-settings')).not.toHaveAttribute('open');
    await page.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
    await expect(page.locator('#agent-copy-status')).toContainText('Copied');
    const copied = await page.evaluate(() => (window as unknown as { copiedPrompt: string }).copiedPrompt);
    expect(copied).toContain('https://github.com/Syndr0/open-immersive-translator');
    expect(copied).toContain('apps/extension/dist');
    expect(copied).toContain('do not hand me terminal commands');
    await page.evaluate(() => { (window as unknown as { blockCopy: boolean }).blockCopy = true; });
    await page.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Website setup request for your agent' });
    await expect(field).toBeVisible();
    expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
    await expect(page.locator('#agent-copy-status')).toContainText('Copy the selected text');
  }
  expect(errors).toEqual([]);
});
