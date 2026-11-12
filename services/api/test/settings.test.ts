import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

/** A minimal OpenAI-compatible service that records the credentials it was sent. */
async function fakeService(prefix: string) {
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 42 }] })); return; }
      const input = JSON.parse(JSON.parse(body).messages[1].content) as { segments: Array<{ id: string; text: string }> };
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segments: input.segments.map(segment => ({ id: segment.id, text: `${prefix}${segment.text}` })) }) } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, authorizations, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}
const listen = async (app: Awaited<ReturnType<typeof createApp>>['app']) => {
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const closeAll = (...servers: Server[]) => Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('the translation service switches at runtime, persists, and never returns or misdirects API keys', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-settings-test-`);
  const env = { TRANSLATION_PROVIDER: 'demo' };
  const first = await fakeService('A:'), second = await fakeService('B:');
  const api = await createApp({ dataDir, env });
  const { server, base } = await listen(api.app);
  const translate = () => fetch(`${base}/api/translate`, json('POST', { segments: [{ id: 's', text: 'Hello' }], targetLanguage: 'fr' })).then(r => r.json());
  try {
    const initial = await fetch(`${base}/api/settings`).then(r => r.json());
    assert.deepEqual(initial.active, { kind: 'demo', model: 'fixture-only', configured: true });
    assert.equal(initial.source, 'environment');
    assert.equal(initial.provider.compatible.hasApiKey, false);
    assert.equal((await translate()).results[0].text, '[Demo · fr] Hello');

    // Unsaved choices can be tried and their models listed without changing the active service.
    const candidate = { kind: 'compatible', compatible: { baseUrl: first.baseUrl, model: 'model-a', apiKey: 'test-key-1' } };
    const tested = await fetch(`${base}/api/settings/provider/test`, json('POST', { ...candidate, targetLanguage: 'fr' })).then(r => r.json());
    assert.equal(tested.ok, true); assert.equal(tested.text, 'A:Open tools make research reproducible.'); assert.equal(tested.model, 'model-a');
    assert.deepEqual((await fetch(`${base}/api/settings/provider/models`, json('POST', candidate)).then(r => r.json())).models, ['model-a', 'model-b']);
    assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).provider.kind, 'demo');

    const savedResponse = await fetch(`${base}/api/settings/provider`, json('PUT', candidate));
    const savedText = await savedResponse.text();
    assert.equal(savedResponse.status, 200); assert.equal(savedText.includes('test-key-1'), false);
    const saved = JSON.parse(savedText);
    assert.deepEqual(saved.active, { kind: 'compatible', model: 'model-a', configured: true });
    assert.equal(saved.source, 'saved'); assert.equal(saved.provider.compatible.hasApiKey, true);
    assert.equal((await translate()).results[0].text, 'A:Hello');
    assert.ok(first.authorizations.every(value => value === 'Bearer test-key-1'));
    assert.equal((await stat(`${dataDir}/settings.json`)).mode & 0o077, 0, 'the settings file is private to its owner');
    assert.ok((await readFile(`${dataDir}/settings.json`, 'utf8')).includes('test-key-1'));

    // Changing only the model keeps the key; changing the server drops it.
    const sameServer = await fetch(`${base}/api/settings/provider`, json('PUT', { kind: 'compatible', compatible: { model: 'model-b' } })).then(r => r.json());
    assert.equal(sameServer.provider.compatible.hasApiKey, true); assert.equal(sameServer.active.model, 'model-b');
    const moved = await fetch(`${base}/api/settings/provider/test`, json('POST', { kind: 'compatible', compatible: { baseUrl: second.baseUrl } })).then(r => r.json());
    assert.equal(moved.ok, true); assert.equal(moved.text.startsWith('B:'), true);
    assert.deepEqual(second.authorizations, [undefined], 'a key is never sent to a server it was not entered for');

    // Extensions may read status but not redirect the service; invalid input changes nothing.
    assert.equal((await fetch(`${base}/api/settings`, { headers: { Origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 200);
    for (const path of ['/api/settings/provider', '/api/settings/provider/test', '/api/settings/provider/models']) {
      assert.equal((await fetch(`${base}${path}`, json(path.endsWith('provider') ? 'PUT' : 'POST', { kind: 'google-free' }, { Origin: `chrome-extension://${'a'.repeat(32)}` }))).status, 403);
    }
    for (const invalid of [{ kind: 'demo' }, { kind: 'compatible', compatible: { baseUrl: 'file:///etc/passwd' } }, { kind: 'ollama', ollama: { baseUrl: 'http://user:pass@127.0.0.1:1' } }, { kind: 'codex', codex: { cliPath: '/bin/sh' } }]) {
      const response = await fetch(`${base}/api/settings/provider`, json('PUT', invalid));
      if (invalid.kind === 'codex') assert.equal(JSON.stringify(await response.json()).includes('/bin/sh'), false, 'the Codex executable is not settable');
      else assert.equal(response.status, 400);
    }
    await fetch(`${base}/api/settings/provider`, json('PUT', { kind: 'compatible' }));
    assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).provider.model, 'model-b');

    // A restart keeps the saved choice; resetting returns to the environment.
    const restarted = await createApp({ dataDir, env });
    const again = await listen(restarted.app);
    try {
      assert.deepEqual((await fetch(`${again.base}/api/settings`).then(r => r.json())).active, { kind: 'compatible', model: 'model-b', configured: true });
      const reset = await fetch(`${again.base}/api/settings/provider`, { method: 'DELETE' }).then(r => r.json());
      assert.equal(reset.source, 'environment'); assert.equal(reset.active.kind, 'demo');
      assert.equal((await readFile(`${dataDir}/settings.json`, 'utf8')).includes('test-key-1'), false);
    } finally { restarted.close(); await closeAll(again.server); }
  } finally { api.close(); await closeAll(server, first.server, second.server); await rm(dataDir, { recursive: true, force: true }); }
});

test('a missing key or unreachable service reports a failed test instead of an error page', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-settings-test-`);
  const api = await createApp({ dataDir, env: { TRANSLATION_PROVIDER: 'demo' } });
  const { server, base } = await listen(api.app);
  try {
    const missing = await fetch(`${base}/api/settings/provider/test`, json('POST', { kind: 'google' })).then(r => r.json());
    assert.deepEqual(missing, { ok: false, error: 'This service is not fully set up yet.' });
    const unreachable = await fetch(`${base}/api/settings/provider/test`, json('POST', { kind: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:9', model: 'none' } })).then(r => r.json());
    assert.equal(unreachable.ok, false); assert.match(unreachable.error, /Cannot reach ollama/);
    assert.deepEqual(await fetch(`${base}/api/settings/provider/models`, json('POST', { kind: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:9' } })).then(r => r.json()), { models: [] });
    const unconfigured = await fetch(`${base}/api/settings/provider`, json('PUT', { kind: 'google' })).then(r => r.json());
    assert.deepEqual(unconfigured.active, { kind: 'google', model: 'nmt', configured: false });
  } finally { api.close(); await closeAll(server); await rm(dataDir, { recursive: true, force: true }); }
});
