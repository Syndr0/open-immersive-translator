import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/background.ts', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0]!.text;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function background() {
  let listener!: (message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean;
  const sent: Array<{ tabId: number; message: { type: string; settings?: { backendUrl: string; targetLanguage: string } }; frameId: number }> = [];
  const injections: unknown[] = [], styles: unknown[] = [];
  const session: Record<string, unknown> = {};
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
    tabs: { async sendMessage(tabId: number, message: typeof sent[number]['message'], options: { frameId: number }) { sent.push(plain({ tabId, message, frameId: options.frameId })); return { ok: true }; }, onRemoved: { addListener() {} } },
  };
  runInNewContext(bundle, { chrome, URL, AbortSignal, fetch: async () => { fetches++; throw new Error('Unexpected network access'); } });
  return { sent, injections, styles, session, fetches: () => fetches,
    send: (message: unknown, sender: unknown) => new Promise<{ error?: string; ok?: boolean; frames?: number }>(resolve => { assert.equal(listener(message, sender, value => resolve(value as never)), true); }),
  };
}

const sender = { tab: { id: 12 }, frameId: 0, url: 'https://example.org/article' };

test('manifest passively installs the top-frame launcher and CSS on HTTP(S) websites', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.content_scripts, [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'], css: ['content.css'], run_at: 'document_idle', all_frames: false }]);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
  assert.equal(manifest.externally_connectable, undefined);
});

test('launcher uses its sender tab and stored settings without an activeTab injection or network request', async () => {
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
  assert.equal(worker.fetches(), 0);
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
