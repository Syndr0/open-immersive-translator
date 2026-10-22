import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

async function installChromeTransport(page: Page): Promise<void> {
  // Emulate only the Chrome message transport. The bundled content script,
  // browser DOM/observers and translation HTTP backend are real.
  await page.addInitScript(() => {
    const state = window as unknown as { __oitListeners: Array<(message: unknown, sender: unknown, respond: (reply: unknown) => void) => void>; chrome: unknown };
    state.__oitListeners = [];
    state.chrome = { runtime: {
      onMessage: { addListener: (listener: typeof state.__oitListeners[number]) => state.__oitListeners.push(listener) },
      sendMessage: async (message: { type: string; segments?: unknown; targetLanguage?: string; sourceLanguage?: string; jobId?: string }) => {
        if (message.type === 'oit:launcher-start' || message.type === 'oit:launcher-restore') {
          return new Promise(resolveReply => {
            for (const listener of state.__oitListeners) listener(message.type === 'oit:launcher-start'
              ? { type: 'oit:start', settings: { targetLanguage: 'zh-Hans', sourceLanguage: 'auto', theme: 'subtle' } }
              : { type: 'oit:restore' }, {}, resolveReply);
          });
        }
        let response: Response;
        if (message.type === 'oit:translation-start') response = await fetch('/api/translation-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
        else if (message.type === 'oit:translation-status') response = await fetch(`/api/jobs/${message.jobId}`);
        else if (message.type === 'oit:translation-cancel') response = await fetch(`/api/jobs/${message.jobId}/cancel`, { method: 'POST' });
        else return {};
        return response.json();
      },
    } };
  });
}

async function installBuiltTranslator(page: Page): Promise<void> {
  await page.addStyleTag({ path: resolve('apps/extension/dist/content.css') });
  await page.addScriptTag({ path: resolve('apps/extension/dist/content.js') });
}

async function startBuiltTranslator(page: Page): Promise<void> {
  await installBuiltTranslator(page);
  await page.evaluate(() => {
    const state = window as unknown as { __oitListeners: Array<(message: unknown, sender: unknown, respond: (reply: unknown) => void) => void> };
    for (const listener of state.__oitListeners) listener({ type: 'oit:start', settings: { targetLanguage: 'zh-Hans', sourceLanguage: 'auto', theme: 'subtle' } }, {}, () => {});
  });
}

test('built content script translates through the backend and restores original DOM', async ({ page }) => {
  await page.route('**/web-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><body>
    <main><h1>Open tools for readers</h1><p id="intro">Read <a href="https://example.org/research">this research</a> and keep <code>npm test</code> intact.</p><pre>const untouched = true;</pre></main>
  </body></html>` }));
  await installChromeTransport(page);
  await page.goto('/web-fixture');
  const original = await page.locator('#intro').innerHTML();
  await startBuiltTranslator(page);
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

test('built website translation retains page typography and safe identities while excluding hidden labels', async ({ page }) => {
  const inputs: Array<{ id: string; text: string }> = [];
  await page.route('**/api/translation-jobs', async route => {
    inputs.push(...route.request().postDataJSON().segments);
    await route.continue();
  });
  await page.route('**/arxiv-style-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><style>
    body { margin: 0; color: #333; font: 16px/1.5 Georgia, serif; }
    nav { background: #242424; color: #fff; padding: 12px 24px; }
    main { max-width: 900px; margin: 24px auto; }
    h1 { font: 700 40px/1.15 Georgia, serif; margin: 18px 0 24px; }
    blockquote { margin: 24px 56px; font-style: italic; }
    .descriptor { display: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
    .skip-link { position: absolute; left: -10000px; top: 0; }
  </style></head><body>
    <a class="skip-link" href="#main">SKIP_LINK_SENTINEL</a>
    <nav id="dark-nav">Research tools for everyone</nav>
    <main id="main">
      <h1 id="paper-title"><span class="descriptor">Title:</span> Open methods for scientific readers</h1>
      <section><span class="descriptor">Abstract:</span><p id="abstract-summary">Read <a id="research-link" href="https://example.org/research" target="_blank" onclick="window.unsafeClick = true">this research</a> and keep <code id="source-code" onclick="window.unsafeCode = true">npm test</code> and <math id="source-equation"><mi>x</mi><mo>=</mo><mn>1</mn></math> intact.<span aria-hidden="true">ARIA_HIDDEN_SENTINEL</span><span class="sr-only">SCREEN_READER_SENTINEL</span></p></section>
      <blockquote id="quotation">Open knowledge should remain accessible to every reader.</blockquote>
      <p hidden>HIDDEN_PARAGRAPH_SENTINEL</p>
    </main>
  </body></html>` }));
  await installChromeTransport(page);
  await page.goto('/arxiv-style-fixture');
  const original = await page.locator('#abstract-summary').innerHTML();
  await startBuiltTranslator(page);
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(4);
  await expect(page.locator('[data-oit-pending="true"]')).toHaveCount(0);

  const title = page.locator('#paper-title + [data-oit-owned="translation"]');
  await expect(title).toContainText('[Demo');
  await expect(title).toHaveCSS('font-size', '40px');
  await expect(title).toHaveCSS('font-weight', '700');
  const navigation = page.locator('#dark-nav + [data-oit-owned="translation"]');
  await expect(navigation).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(navigation).toHaveCSS('background-color', 'rgb(36, 36, 36)');
  const quotation = page.locator('#quotation + [data-oit-owned="translation"]');
  await expect(quotation).toHaveCSS('margin-left', '56px');
  const sourceBox = await page.locator('#quotation').boundingBox();
  const translatedBox = await quotation.boundingBox();
  expect(sourceBox).not.toBeNull(); expect(translatedBox).not.toBeNull();
  expect(translatedBox!.x).toBeCloseTo(sourceBox!.x, 1);

  const paragraph = page.locator('#abstract-summary + [data-oit-owned="translation"]');
  await expect(paragraph.locator('a')).toHaveAttribute('href', 'https://example.org/research');
  await expect(paragraph.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(paragraph.locator('a')).not.toHaveAttribute('onclick');
  await expect(paragraph.locator('code')).toHaveText('npm test');
  await expect(paragraph.locator('code')).not.toHaveAttribute('onclick');
  await expect(paragraph.locator('math')).toHaveText('x=1');
  await expect(page.locator('#research-link')).toHaveCount(1);
  await expect(page.locator('#source-code')).toHaveCount(1);
  await expect(page.locator('#source-equation')).toHaveCount(1);
  expect(await page.locator('#abstract-summary').innerHTML()).toBe(original);
  const sent = JSON.stringify(inputs);
  expect(inputs).toHaveLength(4);
  expect(sent).not.toMatch(/Title:|Abstract:|ARIA_HIDDEN_SENTINEL|SCREEN_READER_SENTINEL|SKIP_LINK_SENTINEL|HIDDEN_PARAGRAPH_SENTINEL|npm test|x=1/);
  expect(sent).toContain('[[OIT_KEEP_');
  expect(await page.locator('[data-oit-owned="translation"]').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/Title:|Abstract:|SENTINEL/)]));

  await page.getByRole('button', { name: 'Restore original page' }).click();
  await expect(page.locator('[data-oit-owned]:not([data-oit-owned="launcher"])')).toHaveCount(0);
  await expect(page.locator('[data-oit-launcher]')).toHaveCount(1);
  expect(await page.locator('#abstract-summary').innerHTML()).toBe(original);
});

test('built website translation shows partial progress and Restore cancels before late output', async ({ page }) => {
  let segments: Array<{ id: string; text: string }> = [];
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>(resolveGate => { releaseFinal = resolveGate; });
  let finalReady = false, cancelled = false, statusCalls = 0;
  const jobId = 'website-progress-fixture';
  await page.route('**/api/translation-jobs', async route => {
    segments = route.request().postDataJSON().segments;
    void finalGate.then(() => { finalReady = true; });
    await route.fulfill({ json: { jobId } });
  });
  await page.route(`**/api/jobs/${jobId}`, async route => {
    statusCalls++;
    const results = (finalReady ? segments : segments.slice(0, 1)).map(segment => ({ id: segment.id, text: `已翻译：${segment.text}` }));
    await route.fulfill({ json: { id: jobId, status: finalReady ? 'completed' : 'running', completed: results.length, total: segments.length, result: { results, errors: [] } } });
  });
  await page.route(`**/api/jobs/${jobId}/cancel`, async route => {
    expect(route.request().method()).toBe('POST'); cancelled = true;
    await route.fulfill({ json: { id: jobId, status: 'cancelled' } });
  });
  await page.route('**/website-progress-page', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><body><main>
    <p id="first">The first paragraph can appear before the whole page finishes.</p>
    <p id="second">The second paragraph is deliberately waiting for a slower translation.</p>
  </main></body></html>` }));
  await installChromeTransport(page);
  await page.goto('/website-progress-page');
  const original = await page.locator('main').innerHTML();
  await startBuiltTranslator(page);
  await expect(page.locator('#first + [data-oit-owned="translation"]')).toContainText('已翻译：');
  const second = page.locator('#second + [data-oit-owned="translation"]');
  await expect(second).toHaveAttribute('data-oit-pending', 'true');
  await expect(second).toHaveAttribute('aria-busy', 'true');
  await expect(second).toHaveText('Translating…');
  expect(segments).toHaveLength(2);
  expect(finalReady).toBe(false);
  await expect(page.locator('[data-oit-owned="launcher"]').getByRole('status')).toContainText('1 of 2');
  await page.getByRole('button', { name: 'Restore original page' }).click();
  await expect(page.locator('[data-oit-owned]:not([data-oit-owned="launcher"])')).toHaveCount(0);
  await expect(page.locator('[data-oit-launcher]')).toHaveCount(1);
  await expect.poll(() => cancelled).toBe(true);
  const pollsAtRestore = statusCalls;
  releaseFinal();
  await expect.poll(() => finalReady).toBe(true);
  // Let an additional polling interval elapse after the deliberately late result.
  await page.waitForTimeout(650);
  await expect(page.locator('[data-oit-owned]:not([data-oit-owned="launcher"])')).toHaveCount(0);
  await expect(page.locator('[data-oit-launcher]')).toHaveCount(1);
  expect(statusCalls).toBe(pollsAtRestore);
  expect(await page.locator('main').innerHTML()).toBe(original);
});

test('automatic launcher is passive until a trusted Translate click and remains available after Restore', async ({ page }) => {
  let starts = 0;
  await page.route('**/api/translation-jobs', async route => { starts++; await route.continue(); });
  await page.route('**/automatic-launcher-page', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><main><p id="passive-source">A website control should wait for the reader to choose translation.</p></main></body></html>' }));
  await installChromeTransport(page);
  await page.goto('/automatic-launcher-page');
  const original = await page.locator('#passive-source').innerHTML();
  await installBuiltTranslator(page);
  const launcher = page.locator('[data-oit-launcher]');
  await expect(launcher).toHaveCount(1);
  await expect(launcher.getByRole('button', { name: 'Translate this page', exact: true })).toBeVisible();
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
  await page.evaluate(() => {
    const host = document.querySelector('[data-oit-launcher]')!;
    (host.shadowRoot!.querySelector('[data-action="translate"]') as HTMLButtonElement).click();
  });
  await page.waitForTimeout(150);
  expect(starts).toBe(0);
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
  await launcher.getByRole('button', { name: 'Translate this page', exact: true }).click();
  await expect(page.locator('#passive-source + [data-oit-owned="translation"]')).toContainText('[Demo');
  expect(starts).toBe(1);
  await launcher.getByRole('button', { name: 'Restore original page' }).click();
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
  await expect(launcher).toHaveCount(1);
  await expect(launcher.getByRole('button', { name: 'Translate this page', exact: true })).toBeVisible();
  expect(await page.locator('#passive-source').innerHTML()).toBe(original);
});

test('long-page translation stops spinning while offscreen content waits and resumes on scroll', async ({ page }) => {
  let starts = 0;
  let release!: () => void;
  const secondRequest = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/translation-jobs', async route => {
    starts++;
    if (starts === 2) await secondRequest;
    await route.continue();
  });
  await page.route('**/scroll-waiting-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><main><p id="near">A nearby public paragraph.</p><div aria-hidden="true" style="height:4800px"></div><p id="far">An offscreen public paragraph.</p></main></body></html>' }));
  await installChromeTransport(page);
  await page.goto('/scroll-waiting-fixture');
  const original = await page.locator('main').innerHTML();
  await installBuiltTranslator(page);
  const launcher = page.locator('[data-oit-launcher]');
  await launcher.getByRole('button', { name: 'Translate this page', exact: true }).click();
  await expect(page.locator('#near + [data-oit-owned="translation"]')).toContainText('[Demo');
  await expect(launcher.getByRole('status')).toHaveText('1 of 2 paragraphs translated · 1 remaining. Scroll to translate more.');
  await expect(launcher.locator('.label')).toHaveText('Ready');
  await expect(launcher.locator('.rail')).not.toHaveClass(/working/);
  await expect(launcher.locator('[data-action="translate"]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-oit-pending="true"]')).toHaveCount(0);
  expect(starts).toBe(1);
  try {
    await page.locator('#far').scrollIntoViewIfNeeded();
    await expect.poll(() => starts).toBe(2);
    await expect(launcher.locator('.label')).toHaveText('Translating');
    await expect(launcher.locator('[data-action="translate"]')).toHaveAttribute('aria-busy', 'true');
  } finally { release(); }
  await expect(page.locator('#far + [data-oit-owned="translation"]')).toContainText('[Demo');
  await expect(launcher.getByRole('status')).toHaveText('2 of 2 paragraphs translated');
  await expect(launcher.locator('.label')).toHaveText('Translated');
  await expect(launcher.locator('[data-action="translate"]')).toHaveAttribute('aria-busy', 'false');
  await launcher.getByRole('button', { name: 'Restore original page' }).click();
  await expect(page.locator('[data-oit-owned="translation"]')).toHaveCount(0);
  expect(await page.locator('main').innerHTML()).toBe(original);
});
