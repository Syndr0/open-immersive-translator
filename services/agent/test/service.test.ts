import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceDocument } from '@oit/core';
import { AgentApi } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { AgentService } from '../src/service.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const active = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const document = (): SourceDocument => ({ id: ID, name: 'notes.md', format: 'md', sourceHash: 'fixture-source-hash', warnings: [], createdAt: '2026-10-21T00:00:00Z', blocks: [
  { id: 'prose', type: 'paragraph', text: 'Keep $E=mc^2$ and `code()`.' },
  { id: 'code', type: 'code', text: 'const original = 42;' },
] });

test('agent API blocks remote destinations, redirects, oversized responses and reports offline setup guidance', async () => {
  const config = loadConfig({}, '/workspace');
  const seen: RequestInit[] = [];
  const redirectApi = new AgentApi(config, async (_url, init) => { seen.push(init!); return new Response('', { status: 302, headers: { Location: 'https://outside.example' } }); });
  await assert.rejects(() => redirectApi.request('/api/health'), /redirect/);
  assert.equal(seen[0]!.redirect, 'error');
  for (const path of ['https://outside.example/api/health', '//outside.example/api/health', '/api/../../other', '/api/\\outside']) await assert.rejects(() => redirectApi.request(path), /Invalid|local API/);
  const big = new AgentApi(config, async () => new Response('', { headers: { 'Content-Length': String(51 * 1024 * 1024) } }));
  await assert.rejects(() => big.request('/api/health'), /50 MB/);
  const offline = new AgentApi(config, async () => { throw new Error('ECONNREFUSED fixture'); });
  await assert.rejects(() => offline.json('/api/health'), /Start it from the repository with npm start/);
});

test('unconfigured provider stops backend translation before creating a job; agent mode remains available', async () => {
  const paths: string[] = [];
  const service = new AgentService(loadConfig({}, '/workspace'), async url => {
    paths.push(String(url)); return json({ ok: true, version: '0.1.0', provider: { kind: 'google', model: 'nmt', configured: false } });
  });
  const status = await service.getStatus(active());
  assert.equal(status.provider.configured, false);
  assert.equal(status.agentTranslation.available, true);
  await assert.rejects(() => service.translateDocument({ documentId: ID, targetLanguage: 'fr' }, active()), /get_document and save_translations/);
  assert.equal(paths.every(path => path.endsWith('/api/health')), true);
});

test('document paging supplies protected agent inputs and keeps stable browser reader links', async () => {
  const source = document();
  const service = new AgentService(loadConfig({}, '/workspace'), async () => json({ document: source, translations: { targetLanguage: 'fr', units: { prose: 'Saved translation' } } }));
  const first = await service.getDocument({ documentId: ID, targetLanguage: 'fr', limit: 1 }, active());
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  assert.equal(first.blocks[0]!.text, source.blocks[0]!.text);
  assert.equal(first.blocks[0]!.translationInput, 'Keep ⟪OIT_0⟫ and ⟪OIT_1⟫.');
  assert.equal(first.blocks[0]!.translation, 'Saved translation');
  const reader = new URL(first.readerUrl);
  assert.equal(reader.searchParams.get('document'), ID); assert.equal(reader.searchParams.get('targetLanguage'), 'fr');
  const second = await service.getDocument({ documentId: ID, targetLanguage: 'fr', offset: 1, limit: 1 }, active());
  assert.equal(second.nextOffset, undefined); assert.equal(second.blocks[0]!.translationInput, undefined);
  const latest = await service.getDocument({ documentId: ID }, active());
  assert.equal(latest.targetLanguage, 'fr');
  assert.equal(new URL(latest.readerUrl).searchParams.get('targetLanguage'), 'fr');
});

test('large documents page within an output budget and explicitly flag oversized blocks', async () => {
  const source = document();
  source.blocks = Array.from({ length: 60 }, (_, index) => ({ id: `block-${index}`, type: 'paragraph', text: `${index} ` + 'Readable prose '.repeat(500) }));
  const service = new AgentService(loadConfig({}, '/workspace'), async () => json({ document: source }));
  let offset = 0;
  const ids: string[] = [];
  while (offset < source.blocks.length) {
    const page = await service.getDocument({ documentId: ID, offset, limit: 100 }, active());
    assert.ok(JSON.stringify(page).length < 200_000);
    ids.push(...page.blocks.map(block => String(block.id)));
    offset = page.nextOffset ?? source.blocks.length;
  }
  assert.deepEqual(ids, source.blocks.map(block => block.id));
  source.blocks = [{ id: 'large', type: 'paragraph', text: 'x'.repeat(100_001) }];
  const oversized = await service.getDocument({ documentId: ID }, active());
  assert.equal(oversized.blocks[0]!.sourceTruncated, true);
  assert.equal(oversized.blocks[0]!.translationInput, undefined);
  assert.match(String(oversized.blocks[0]!.translationInputUnavailable), /Do not submit/);
});

test('agent import/save/export wrap the existing API without a separate provider or duplicated document store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oit-agent-service-'));
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const config = loadConfig({ OIT_OUTPUT_DIR: join(root, 'exports') }, root);
  const source = document();
  const service = new AgentService(config, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method || 'GET';
    calls.push({ path, method, body: init?.body });
    if (path.endsWith('/translations')) return json({ saved: 1, translated: 1, total: 1, complete: true, method: 'agent' });
    if (path.endsWith('/export')) return new Response('<!doctype html><p>Original &amp; translated</p>');
    return json({ document: source, translations: { targetLanguage: 'fr', units: { prose: 'Préserver la formule et le code.' } } });
  });
  try {
    const imported = await service.importDocument({ fileName: 'notes.md', text: 'Original Markdown' }, active());
    assert.equal(imported.document.id, ID);
    assert.equal(Buffer.from(calls[0]!.body as Uint8Array).toString(), 'Original Markdown');
    const saved = await service.saveTranslations({ documentId: ID, targetLanguage: 'fr', segments: [{ id: 'prose', text: 'Préserver ⟪OIT_0⟫ et ⟪OIT_1⟫.' }] }, active());
    assert.equal(saved.translationSource, 'agent-provided'); assert.equal(saved.complete, true);
    assert.equal(calls.some(call => call.path.endsWith('/translate')), false);
    const exported = await service.exportDocument({ documentId: ID, targetLanguage: 'fr', format: 'html' }, active());
    assert.equal(await readFile(exported.path, 'utf8'), exported.inlineText);
    assert.match(exported.preview, /Keep \$E=mc\^2\$/);
    assert.match(exported.preview, /Préserver la formule/);
    assert.equal(exported.preview.includes('<!doctype'), false);
    assert.equal(new URL(exported.downloadUrl).pathname, `/api/documents/${ID}/export`);
    const another = await service.exportDocument({ documentId: ID, targetLanguage: 'fr', format: 'html' }, active());
    assert.notEqual(another.path, exported.path);
    const translatedOnly = await service.exportDocument({ documentId: ID, targetLanguage: 'fr', format: 'html', mode: 'translated' }, active());
    assert.equal(translatedOnly.preview.includes('Keep $E=mc^2$'), false);
    assert.match(translatedOnly.preview, /Préserver la formule/);
    assert.match(translatedOnly.preview, /const original = 42/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backend translation returns a job immediately and short status/cancel results omit bulk job output', async () => {
  const service = new AgentService(loadConfig({}, '/workspace'), async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/health')) return json({ ok: true, version: '0.1.0', provider: { kind: 'demo', model: 'fixture-only', configured: true } });
    if (path.endsWith('/translate')) return json({ jobId: JOB });
    return json({ id: JOB, status: init?.method === 'POST' ? 'cancelled' : 'running', completed: 0, total: 5, result: { results: [{ text: 'Bulk output' }] } });
  });
  const started = await service.translateDocument({ documentId: ID, targetLanguage: 'ja' }, active());
  assert.equal(started.jobId, JOB); assert.equal(started.provider.kind, 'demo');
  const status = await service.getJob(JOB, active());
  assert.equal(status.status, 'running'); assert.equal('result' in status, false);
  assert.equal((await service.cancelJob(JOB, active())).status, 'cancelled');
});
