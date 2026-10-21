import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('built content script translates through the backend and restores original DOM', async ({ page }) => {
  await page.route('**/web-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><body>
    <main><h1>Open tools for readers</h1><p id="intro">Read <a href="https://example.org/research">this research</a> and keep <code>npm test</code> intact.</p><pre>const untouched = true;</pre></main>
  </body></html>` }));
  // Emulate only the Chrome message transport. The bundled content script,
  // browser DOM/observers and translation HTTP backend are real.
  await page.addInitScript(() => {
    const state = window as unknown as { __oitListeners: Array<(message: unknown, sender: unknown, respond: (reply: unknown) => void) => void>; chrome: unknown };
    state.__oitListeners = [];
    state.chrome = { runtime: {
      onMessage: { addListener: (listener: typeof state.__oitListeners[number]) => state.__oitListeners.push(listener) },
      sendMessage: async (message: { type: string; segments?: unknown; targetLanguage?: string; sourceLanguage?: string; jobId?: string }) => {
        let response: Response;
        if (message.type === 'oit:translation-start') response = await fetch('/api/translation-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
        else if (message.type === 'oit:translation-status') response = await fetch(`/api/jobs/${message.jobId}`);
        else if (message.type === 'oit:translation-cancel') response = await fetch(`/api/jobs/${message.jobId}/cancel`, { method: 'POST' });
        else return {};
        return response.json();
      },
    } };
  });
  await page.goto('/web-fixture');
  const original = await page.locator('#intro').innerHTML();
  await page.addScriptTag({ path: resolve('apps/extension/dist/content.js') });
  await page.evaluate(() => {
    const state = window as unknown as { __oitListeners: Array<(message: unknown, sender: unknown, respond: (reply: unknown) => void) => void> };
    for (const listener of state.__oitListeners) listener({ type: 'oit:start', settings: { targetLanguage: 'zh-Hans', sourceLanguage: 'auto', theme: 'subtle' } }, {}, () => {});
  });
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(2);
  await expect(page.locator('#intro + [data-oit-owned]')).toContainText('[Demo');
  await expect(page.locator('#intro + [data-oit-owned] a')).toHaveAttribute('href', 'https://example.org/research');
  await expect(page.locator('#intro + [data-oit-owned] code')).toHaveText('npm test');
  expect(await page.locator('#intro').innerHTML()).toBe(original);

  await page.evaluate(() => {
    const paragraph = document.createElement('p');
    paragraph.id = 'dynamic'; paragraph.textContent = 'New content should become bilingual too.';
    document.querySelector('main')!.append(paragraph);
  });
  await expect(page.locator('#dynamic + [data-oit-owned]')).toContainText('[Demo');
  await page.evaluate(() => {
    const state = window as unknown as { __oitListeners: Array<(message: unknown, sender: unknown, respond: (reply: unknown) => void) => void> };
    for (const listener of state.__oitListeners) listener({ type: 'oit:restore' }, {}, () => {});
  });
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
  expect(await page.locator('#intro').innerHTML()).toBe(original);
  await expect(page.locator('pre')).toHaveText('const untouched = true;');
});
