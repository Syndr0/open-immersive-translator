import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { PageStatus } from '../src/engine';

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/background.ts', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0]!.text;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function background(fetcher: () => Promise<unknown> = async () => ({ ok: true, provider: { configured: true, kind: 'test' } })) {
  let listener!: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
  const sent: Array<{ tabId: number; message: { type: string; settings?: { backendUrl: string; targetLanguage: string } }; frameId: number }> = [];
  const injections: unknown[] = [], styles: unknown[] = [];
  const session: Record<string, unknown> = {};
  const frameStates = new Map<number, PageStatus>();
  let fetches = 0;
  const chrome = {
    runtime: { onMessage: { addListener(value: typeof listener) { listener = value; } } },
    storage: {
      local: { async get() { return { settings: { targetLanguage: 'fr' } }; }, async set() {} },
      session: { async get(key: string) { return { [key]: session[key] }; }, async set(values: Record<string, unknown>) { Object.assign(session, plain(values)); }, async remove(key: string) { delete session[key]; } },
    },
    scripting: {
      async executeScript(options: unknown) { injections.push(plain(options)); return [{ frameId: 0 }, { frameId: 3 }]; },
      async insertCSS(options: unknown) { styles.push(plain(options)); },
    },
    tabs: { async sendMessage(tabId: number, message: typeof sent[number]['message'], options: { frameId: number }) { sent.push(plain({ tabId, message, frameId: options.frameId })); return message.type === 'oit:page-status' ? frameStates.get(options.frameId) : { ok: true }; }, onRemoved: { addListener() {} } },
  };
  runInNewContext(bundle, { chrome, URL, AbortSignal, fetch: async () => {
    fetches++;
    const body = await fetcher();
    return { ok: true, json: async () => body };
  } });
  return { sent, injections, styles, session, frameStates, fetches: () => fetches,
    send: (message: unknown, sender: unknown) => new Promise<Partial<PageStatus> & { error?: string; ok?: boolean; frames?: number }>(resolve => { assert.equal(listener(message, sender, value => resolve(value as never)), true); }),
  };
}

const sender = { tab: { id: 12 }, frameId: 0, url: 'https://example.org/article' };

test('combined frame status distinguishes waiting from active translation and completion', async () => {
  const worker = background();
  await worker.send({ type: 'oit:start-tab', tabId: 12 }, {});
  worker.frameStates.set(0, { state: 'waiting', total: 2, translated: 1, failed: 0, pending: 1 });
  worker.frameStates.set(3, { state: 'ready', total: 1, translated: 1, failed: 0, pending: 0 });
  assert.deepEqual(plain(await worker.send({ type: 'oit:tab-status', tabId: 12 }, {})), { state: 'waiting', total: 3, translated: 2, failed: 0, pending: 1 });
  worker.frameStates.set(3, { state: 'translating', total: 1, translated: 0, failed: 0, pending: 1 });
  assert.equal((await worker.send({ type: 'oit:tab-status', tabId: 12 }, {})).state, 'translating');
  worker.frameStates.set(0, { state: 'ready', total: 2, translated: 2, failed: 0, pending: 0 });
  worker.frameStates.set(3, { state: 'ready', total: 1, translated: 1, failed: 0, pending: 0 });
  assert.deepEqual(plain(await worker.send({ type: 'oit:tab-status', tabId: 12 }, {})), { state: 'ready', total: 3, translated: 3, failed: 0, pending: 0 });
  worker.frameStates.set(0, { state: 'ready', total: 2, translated: 1, skipped: 1, failed: 0, pending: 0 });
  assert.deepEqual(plain(await worker.send({ type: 'oit:tab-status', tabId: 12 }, {})), { state: 'ready', total: 3, translated: 2, skipped: 1, failed: 0, pending: 0 });
});

test('manifest passively installs the top-frame launcher and CSS on HTTP(S) websites', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.content_scripts, [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'], css: ['content.css'], run_at: 'document_idle', all_frames: false }]);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.equal(manifest.externally_connectable, undefined);
});

test('launcher stays passive until Translate, then checks the service before starting its sender tab', async () => {
  const worker = background();
  assert.equal(worker.fetches(), 0);
  const result = await worker.send({ type: 'oit:launcher-start', tabId: 999, settings: { backendUrl: 'https://untrusted.example', targetLanguage: 'wrong' } }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.frames, 1);
  assert.deepEqual(worker.sent.map(value => ({ tabId: value.tabId, frameId: value.frameId, type: value.message.type })), [{ tabId: 12, frameId: 0, type: 'oit:start' }]);
  assert.equal(worker.sent[0]!.message.settings!.backendUrl, 'http://127.0.0.1:8787');
  assert.equal(worker.sent[0]!.message.settings!.targetLanguage, 'fr');
  assert.deepEqual(worker.injections, []);
  assert.deepEqual(worker.styles, []);
  assert.deepEqual(worker.session['oit:frames:12'], [0]);
  assert.equal(worker.fetches(), 1);
});

test('offline service prevents launcher scans and toolbar injection and permits a later retry', async () => {
  let online = false;
  const worker = background(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return { ok: true, provider: { configured: true } };
  });
  assert.equal(worker.fetches(), 0);
  for (const [message, origin] of [
    [{ type: 'oit:launcher-start' }, sender],
    [{ type: 'oit:start-tab', tabId: 12 }, {}],
  ] as const) {
    assert.match((await worker.send(message, origin)).error!, /translation service is offline.*retry/i);
  }
  assert.deepEqual(worker.sent, []);
  assert.deepEqual(worker.injections, []);
  assert.deepEqual(worker.styles, []);
  assert.deepEqual(worker.session, {});
  online = true;
  assert.equal((await worker.send({ type: 'oit:launcher-start' }, sender)).ok, true);
  assert.equal(worker.sent.length, 1);
});

test('unconfigured or invalid backends cannot start page translation', async () => {
  for (const response of [{ ok: true, provider: { configured: false } }, { ok: true }, null]) {
    const worker = background(async () => response);
    assert.match((await worker.send({ type: 'oit:launcher-start' }, sender)).error!, /provider needs to be set up|not a working Open Immersive Translator backend/);
    assert.deepEqual(worker.sent, []);
    assert.deepEqual(worker.injections, []);
  }
});

test('launcher rejects missing tabs, subframes and non-web senders before any action', async () => {
  const worker = background();
  for (const invalid of [{}, { ...sender, tab: undefined }, { ...sender, tab: { id: -1 } }, { ...sender, frameId: 4 }, { ...sender, frameId: undefined }, { ...sender, url: 'file:///private/document.html' }, { ...sender, url: 'chrome-extension://example/popup.html' }, { ...sender, url: undefined }]) {
    for (const type of ['oit:launcher-start', 'oit:launcher-restore']) assert.match((await worker.send({ type, tabId: 12 }, invalid)).error!, /top frame of a website tab/);
  }
  assert.deepEqual(worker.sent, []);
  assert.deepEqual(worker.injections, []);
  assert.equal(worker.fetches(), 0);
});

test('toolbar frame injection remains available and launcher Restore reaches every remembered frame', async () => {
  const worker = background();
  assert.equal((await worker.send({ type: 'oit:start-tab', tabId: 12 }, {})).frames, 2);
  assert.deepEqual(worker.injections, [{ target: { tabId: 12, allFrames: true }, files: ['content.js'] }]);
  assert.deepEqual(worker.styles, [{ target: { tabId: 12, frameIds: [0, 3] }, files: ['content.css'] }]);
  worker.sent.length = 0;
  await worker.send({ type: 'oit:launcher-restore', tabId: 999 }, sender);
  assert.deepEqual(worker.sent.map(value => ({ tabId: value.tabId, frameId: value.frameId, type: value.message.type })), [{ tabId: 12, frameId: 0, type: 'oit:restore' }, { tabId: 12, frameId: 3, type: 'oit:restore' }]);
  worker.sent.length = 0;
  await worker.send({ type: 'oit:launcher-start' }, sender);
  assert.deepEqual(worker.sent.map(value => value.frameId), [0, 3]);
  assert.equal(worker.injections.length, 1);
});

test('a tab cannot use the launcher permission to send arbitrary popup commands', async () => {
  const worker = background();
  for (const type of ['oit:start-tab', 'oit:restore-tab', 'oit:save-settings', 'oit:reader', 'oit:health']) assert.match((await worker.send({ type, tabId: 999 }, sender)).error!, /only in the extension popup/);
  assert.deepEqual(worker.sent, []);
  assert.equal(worker.fetches(), 0);
});
