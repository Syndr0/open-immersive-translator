import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type PopupHealth = 'offline' | 'healthy' | 'unconfigured' | 'invalid';
interface PopupFixtureState {
  health: PopupHealth;
  messages: string[];
  optionsOpened: number;
  failAction?: string;
  pageStatus?: { state: 'waiting' | 'translating' | 'ready'; total: number; translated: number; failed: number; pending: number };
}

async function openPopupFixture(page: Page, health: PopupHealth): Promise<void> {
  await page.clock.install();
  await page.addInitScript(initialHealth => {
    const fixture: PopupFixtureState = { health: initialHealth, messages: [], optionsOpened: 0 };
    const state = window as unknown as { chrome: unknown; popupFixture: PopupFixtureState };
    state.popupFixture = fixture;
    state.chrome = {
      tabs: { query: async () => [{ id: 1 }] },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: {
        openOptionsPage: async () => { fixture.optionsOpened++; },
        sendMessage: async (message: { type: string }) => {
          fixture.messages.push(message.type);
          if (fixture.failAction === message.type) return { error: 'The local service is unavailable for this action.' };
          if (message.type === 'oit:health') {
            if (fixture.health === 'offline') return { error: 'The local service is unavailable' };
            return { ok: fixture.health !== 'invalid', provider: { kind: 'google-free', model: 'web-unofficial', configured: fixture.health !== 'unconfigured' } };
          }
          if (message.type === 'oit:settings') return { backendUrl: 'http://127.0.0.1:8787', readerUrl: 'http://127.0.0.1:8787', targetLanguage: 'zh-Hans', sourceLanguage: 'auto', theme: 'subtle' };
          if (message.type === 'oit:tab-status') return fixture.pageStatus || { state: 'idle', total: 0, translated: 0, failed: 0, pending: 0 };
          return {};
        },
      },
    };
  }, health);
  await page.route('**/ui.css', async route => route.fulfill({ contentType: 'text/css', body: await readFile(resolve('apps/extension/dist/ui.css'), 'utf8') }));
  const html = (await readFile(resolve('apps/extension/dist/popup.html'), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  await page.route('**/extension-health-fixture', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('/extension-health-fixture');
  // The built markup must be safe before asynchronous health/settings checks run.
  await expect(page.locator('#translate')).toBeDisabled();
  await expect(page.locator('#connection')).not.toHaveClass(/\bok\b/);
  await page.addScriptTag({ path: resolve('apps/extension/dist/popup.js') });
}

async function setPopupHealth(page: Page, health: PopupHealth): Promise<void> {
  await page.evaluate(value => { (window as unknown as { popupFixture: PopupFixtureState }).popupFixture.health = value; }, health);
  await page.clock.runFor(3000);
}

test('built popup automatically recovers offline to healthy and disables translation when service disappears', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPopupFixture(page, 'offline');
  const translate = page.locator('#translate'), connection = page.locator('#connection');
  await expect(connection).toContainText('offline');
  await expect(connection).not.toHaveClass(/\bok\b/);
  await expect(translate).toBeDisabled();

  await setPopupHealth(page, 'healthy');
  await expect(connection).toContainText('google-free');
  await expect(connection).toHaveClass(/\bok\b/);
  await expect(translate).toBeEnabled();

  await setPopupHealth(page, 'offline');
  await expect(connection).toContainText('offline');
  await expect(connection).not.toHaveClass(/\bok\b/);
  await expect(translate).toBeDisabled();
  // Action completion must not overwrite the last known unhealthy state.
  await page.locator('#restore').click();
  await expect(translate).toBeDisabled();
  await page.locator('#language').selectOption('ja');
  await expect(translate).toBeDisabled();
  await page.locator('#settings').click();
  await expect(translate).toBeDisabled();
  const fixture = await page.evaluate(() => (window as unknown as { popupFixture: PopupFixtureState }).popupFixture);
  expect(fixture.messages.filter(type => type === 'oit:health').length).toBeGreaterThanOrEqual(3);
  expect(fixture.messages).toContain('oit:restore-tab');
  expect(fixture.messages).toContain('oit:save-settings');
  expect(fixture.optionsOpened).toBe(1);
  expect(fixture.messages).not.toContain('oit:start-tab');
  expect(errors).toEqual([]);
});

test('popup tells deferred content apart from requests still running', async ({ page }) => {
  await openPopupFixture(page, 'healthy');
  await expect(page.locator('#translate')).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { popupFixture: PopupFixtureState }).popupFixture.pageStatus = { state: 'waiting', total: 2, translated: 1, failed: 0, pending: 1 }; });
  await page.clock.runFor(1200);
  await expect(page.locator('#status')).toHaveText('1 of 2 paragraphs translated · Ready. Scroll to translate more.');
  await page.evaluate(() => { (window as unknown as { popupFixture: PopupFixtureState }).popupFixture.pageStatus!.state = 'translating'; });
  await page.clock.runFor(1200);
  await expect(page.locator('#status')).toHaveText('1 of 2 paragraphs translated · 1 remaining');
  await page.evaluate(() => { (window as unknown as { popupFixture: PopupFixtureState }).popupFixture.pageStatus = { state: 'ready', total: 2, translated: 2, failed: 0, pending: 0 }; });
  await page.clock.runFor(1200);
  await expect(page.locator('#status')).toHaveText('2 of 2 paragraphs translated');
});

test('built popup requires both successful health and a configured provider', async ({ page }) => {
  await openPopupFixture(page, 'unconfigured');
  const translate = page.locator('#translate'), connection = page.locator('#connection');
  await expect(connection).toContainText('Setup needed');
  await expect(connection).not.toHaveClass(/\bok\b/);
  await expect(translate).toBeDisabled();
  await page.locator('#restore').click();
  await page.locator('#language').selectOption('fr');
  await expect(translate).toBeDisabled();

  // A configured provider on a failed health response is still not ready.
  await setPopupHealth(page, 'invalid');
  await expect(connection).toContainText('Setup needed');
  await expect(connection).not.toHaveClass(/\bok\b/);
  await expect(translate).toBeDisabled();
  await setPopupHealth(page, 'healthy');
  await expect(translate).toBeEnabled();
});

test('failed offline actions stay visible across reconnect polling and never enable Translate', async ({ page }) => {
  await openPopupFixture(page, 'offline');
  await expect(page.locator('#connection')).toContainText('offline');
  await page.evaluate(() => { (window as unknown as { popupFixture: PopupFixtureState }).popupFixture.failAction = 'oit:reader'; });
  await page.locator('#reader').click();
  await expect(page.locator('#error')).toHaveText('The local service is unavailable for this action.');
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#translate')).toBeDisabled();
  await page.clock.runFor(6000);
  await expect(page.locator('#error')).toHaveText('The local service is unavailable for this action.');
  await expect(page.locator('#connection')).toContainText('offline');
  await expect(page.locator('#connection')).not.toHaveClass(/\bok\b/);
  await expect(page.locator('#translate')).toBeDisabled();
});

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
