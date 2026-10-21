import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Provider } from '@oit/core';
import { createApp } from '../src/app.ts';
import { parseDocument, htmlToText, validateDocxArchive } from '../src/parser.ts';
import { providerFromEnv } from '../src/provider.ts';

const fixture: Provider = { kind: 'fixture', model: 'test', configured: true,
  async translate(segments, _source, target) { return segments.map(segment => ({ ...segment, text: `${target}: ${segment.text}` })); } };

test('Markdown preserves headings/code/table identity; HTML strips executable content', async () => {
  const document = await parseDocument('sample.md', Buffer.from('# Title\n\nHello.\n\n```js\nx = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |'));
  assert.deepEqual(document.blocks.map(block => block.type), ['heading', 'paragraph', 'code', 'table']);
  assert.equal(new Set(document.blocks.map(block => block.id)).size, 4);
  assert.equal(htmlToText('<script>bad()</script><h1>A &amp; B</h1><p>safe</p>').includes('bad'), false);
  await assert.rejects(() => parseDocument('fake.pdf', Buffer.from('not pdf')), /PDF header/);
});

test('DOCX preflight rejects excessive declared expansion and malformed archives', () => {
  const zip = Buffer.alloc(68);
  zip.writeUInt32LE(0x02014b50, 0);
  zip.writeUInt32LE(120 * 1024 * 1024, 24);
  zip.writeUInt32LE(0x06054b50, 46);
  zip.writeUInt16LE(1, 56);
  assert.throws(() => validateDocxArchive(zip), /expanded-size/);
  assert.throws(() => validateDocxArchive(Buffer.from('not a docx')), /invalid ZIP/);
});

test('API imports, translates, edits, exports escaped HTML and survives reload', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-api-test-`);
  const api = await createApp({ dataDir, provider: fixture });
  const server = api.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/health`).then(r => r.json())).provider.kind, 'fixture');
    const upload = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'example.md' }, body: '# Title\n\nHello <script>alert(1)</script> and `x = 1`.' });
    assert.equal(upload.status, 201);
    const { document } = await upload.json();
    const { jobId } = await fetch(`${base}/api/documents/${document.id}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr' }) }).then(r => r.json());
    let job;
    for (let i = 0; i < 100; i++) { job = await fetch(`${base}/api/jobs/${jobId}`).then(r => r.json()); if (job.status === 'completed' || job.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(job.status, 'completed');
    const translated = await fetch(`${base}/api/documents/${document.id}?targetLanguage=fr`).then(r => r.json());
    assert.equal(Object.keys(translated.translations.units).length, 2);
    const html = await fetch(`${base}/api/documents/${document.id}/export?format=html`).then(r => r.text());
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
    await fetch(`${base}/api/documents/${document.id}/blocks/${document.blocks[1].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Manual translation', targetLanguage: 'fr' }) });
    const reloaded = await createApp({ dataDir, provider: fixture });
    const record = await reloaded.store.load(document.id);
    assert.equal(record?.translations.fr?.units[document.blocks[1].id], 'Manual translation');
    assert.equal(record?.document.blocks[1].text, document.blocks[1].text);
    const denied = await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } });
    assert.equal(denied.status, 403);
    const source = await fetch(`${base}/api/documents/${document.id}/source`).then(r => r.text()); assert.ok(source.includes('# Title'));
  } finally { api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('cancelled document job never saves late provider output', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-cancel-test-`);
  let release: (() => void) | undefined;
  const provider: Provider = { ...fixture, async translate(segments) { await new Promise<void>(resolve => { release = resolve; }); return segments; } };
  const api = await createApp({ dataDir, provider });
  const server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { document } = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'x.txt' }, body: 'Pending text' }).then(r => r.json());
    const { jobId } = await fetch(`${base}/api/documents/${document.id}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr' }) }).then(r => r.json());
    await fetch(`${base}/api/jobs/${jobId}/cancel`, { method: 'POST' }); release?.();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await api.store.load(document.id))?.translations.fr, undefined);
  } finally { release?.(); api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('demo is explicit and real provider does not silently return fixture translations', () => {
  assert.equal(providerFromEnv({}).kind, 'ollama');
  assert.equal(providerFromEnv({ TRANSLATION_PROVIDER: 'demo' }).kind, 'demo');
  assert.throws(() => providerFromEnv({ TRANSLATION_PROVIDER: 'unknown' }), /must be/);
});

test('partial job failure preserves successful blocks and requires explicit partial export', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-partial-test-`);
  const provider: Provider = { ...fixture, async translate(segments) {
    if (segments[0]!.text.includes('fails')) throw new Error('Fixture failure');
    return segments.map(segment => ({ ...segment, text: `Translated: ${segment.text}` }));
  } };
  const api = await createApp({ dataDir, provider });
  const server = api.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { document } = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'partial.txt' }, body: 'This succeeds.\n\nThis fails.' }).then(response => response.json());
    const { jobId } = await fetch(`${base}/api/documents/${document.id}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr' }) }).then(response => response.json());
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await fetch(`${base}/api/jobs/${jobId}`).then(response => response.json());
      if (job.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'failed');
    const record = await api.store.load(document.id);
    assert.equal(Object.keys(record!.translations.fr!.units).length, 1);
    assert.equal(record!.translations.fr!.units[document.blocks[0].id], 'Translated: This succeeds.');
    assert.equal((await fetch(`${base}/api/documents/${document.id}/export`)).status, 409);
    const partial = await fetch(`${base}/api/documents/${document.id}/export?allowPartial=true`).then(response => response.text());
    assert.ok(partial.includes('Untranslated source'));
  } finally { api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('website jobs return immediately and cancellation discards a late provider result', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-web-job-test-`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider: Provider = { ...fixture, async translate(segments) { await gate; return segments; } };
  const api = await createApp({ dataDir, provider });
  const server = api.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/api/translation-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr', segments: [{ id: 'paragraph', text: 'Pending prose' }] }) });
    assert.equal(response.status, 202);
    const { jobId } = await response.json();
    assert.equal((await fetch(`${base}/api/jobs/${jobId}`).then(result => result.json())).status, 'running');
    await fetch(`${base}/api/jobs/${jobId}/cancel`, { method: 'POST' });
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    const cancelled = await fetch(`${base}/api/jobs/${jobId}`).then(result => result.json());
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.result, undefined);
  } finally { release(); api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});
