import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { protect, type Provider } from '@oit/core';
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

test('Google health reports configuration without returning the server API key', async () => {
  for (const key of [undefined, 'test-only-google-health-key']) {
    const dataDir = await mkdtemp(`${tmpdir()}/oit-google-health-`);
    const api = await createApp({ dataDir, env: { TRANSLATION_PROVIDER: 'google', GOOGLE_TRANSLATE_API_KEY: key } });
    const server = api.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/api/health`);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.deepEqual(JSON.parse(body).provider, { kind: 'google', model: 'nmt', configured: Boolean(key) });
      assert.equal(body.includes('GOOGLE_TRANSLATE_API_KEY'), false);
      if (key) assert.equal(body.includes(key), false);
    } finally {
      api.close(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test('agent translation batches validate protected text atomically and export without a provider', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-agent-save-`);
  const api = await createApp({ dataDir, env: { TRANSLATION_PROVIDER: 'google' } });
  const server = api.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const source = '# Research\n\nKeep $E=mc^2$, `code()` and https://example.com.\n\n```js\nconst source = 1;\n```';
    const { document } = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'agent-notes.md' }, body: source }).then(response => response.json());
    const [heading, prose, code] = document.blocks;
    const save = (segments: Array<{ id: string; text: string }>) => fetch(`${base}/api/documents/${document.id}/translations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'zh-Hans', segments }) });
    assert.equal((await save([{ id: heading.id, text: '研究' }, { id: prose.id, text: 'Missing required markers' }])).status, 400);
    assert.equal((await fetch(`${base}/api/documents/${document.id}/translations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: '__proto__', segments: [{ id: heading.id, text: 'Invalid language key' }] }) })).status, 400);
    assert.deepEqual((await api.store.load(document.id))!.translations, {});
    const translated = protect(prose.text).text.replace('Keep', '保留');
    const result = await save([{ id: heading.id, text: '研究 <script>alert(1)</script>' }, { id: prose.id, text: translated }]);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { documentId: document.id, targetLanguage: 'zh-Hans', method: 'agent', saved: 2, translated: 2, total: 2, complete: true });
    const record = (await api.store.load(document.id))!;
    assert.equal(record.document.blocks[1]!.text, prose.text);
    assert.equal(record.translations['zh-Hans']!.units[prose.id], prose.text.replace('Keep', '保留'));
    assert.equal(record.translations['zh-Hans']!.units[code.id], undefined);
    const exported = await fetch(`${base}/api/documents/${document.id}/export?format=html&targetLanguage=zh-Hans`).then(response => response.text());
    assert.ok(exported.includes('研究 &lt;script&gt;'));
    assert.ok(exported.includes('$E=mc^2$'));
    assert.ok(exported.includes('const source = 1;'));
    assert.ok(!exported.includes('<script>'));
    for (const invalid of [
      [{ id: heading.id, text: 'overwrite' }, { id: heading.id, text: 'duplicate' }],
      [{ id: 'unknown', text: 'unknown' }], [{ id: code.id, text: 'change code' }], [{ id: heading.id, text: '   ' }],
    ]) assert.equal((await save(invalid)).status, 400);
    assert.equal((await api.store.load(document.id))!.translations['zh-Hans']!.units[heading.id], '研究 <script>alert(1)</script>');
    assert.equal((await fetch(`${base}/api/health`).then(response => response.json())).provider.configured, false);
  } finally { api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('saving agent translations cancels a pending provider job and preserves the supplied result', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-agent-conflict-`);
  let release!: () => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const api = await createApp({ dataDir, provider: { ...fixture, async translate(segments) {
    start(); await new Promise<void>(resolve => { release = resolve; });
    return segments.map(segment => ({ ...segment, text: 'Late provider output' }));
  } } });
  const server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { document } = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'agent.txt' }, body: 'Original source' }).then(response => response.json());
    const { jobId } = await fetch(`${base}/api/documents/${document.id}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr' }) }).then(response => response.json());
    await started;
    const saved = await fetch(`${base}/api/documents/${document.id}/translations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr', segments: [{ id: document.blocks[0].id, text: 'Texte fourni par l’agent' }] }) });
    assert.equal(saved.status, 200); release();
    for (let attempt = 0; attempt < 50; attempt++) {
      const job = await fetch(`${base}/api/jobs/${jobId}`).then(response => response.json());
      if (job.status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await fetch(`${base}/api/jobs/${jobId}`).then(response => response.json())).status, 'cancelled');
    assert.equal((await api.store.load(document.id))!.translations.fr!.units[document.blocks[0].id], 'Texte fourni par l’agent');
  } finally { release?.(); api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
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

test('website jobs expose cache hits and fast results while another segment remains gated', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-web-progress-test-`);
  let release!: () => void, slowStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { slowStarted = resolve; });
  const calls: string[] = [];
  const api = await createApp({ dataDir, provider: { ...fixture, async translate(segments) {
    calls.push(segments[0]!.text);
    if (segments[0]!.text === 'Slow source') { slowStarted(); await gate; }
    return segments.map(segment => ({ ...segment, text: `Translated: ${segment.text}` }));
  } } });
  const server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await post('/api/translate', { targetLanguage: 'fr', segments: [{ id: 'warmup', text: 'Cached source' }] });
    const response = await post('/api/translation-jobs', { targetLanguage: 'fr', segments: [{ id: 'cached', text: 'Cached source' }, { id: 'fast', text: 'Fast source' }, { id: 'slow', text: 'Slow source' }] });
    assert.equal(response.status, 202);
    const { jobId } = await response.json(); await started;
    let progress;
    for (let attempt = 0; attempt < 100; attempt++) {
      progress = await fetch(`${base}/api/jobs/${jobId}`).then(result => result.json());
      if (progress.completed === 2) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(progress.status, 'running'); assert.equal(progress.total, 3); assert.equal(progress.completed, 2);
    assert.deepEqual(progress.result.results.map((result: { id: string }) => result.id).sort(), ['cached', 'fast']);
    assert.equal(progress.result.results.find((result: { id: string }) => result.id === 'cached').cached, true);
    assert.equal(calls.filter(text => text === 'Cached source').length, 1);
    release();
    let final;
    for (let attempt = 0; attempt < 100; attempt++) {
      final = await fetch(`${base}/api/jobs/${jobId}`).then(result => result.json());
      if (final.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(final.status, 'completed'); assert.equal(final.completed, 3); assert.equal(final.result.results.length, 3);
  } finally { release(); api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('cancelling a partially completed website job freezes its validated progress', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-web-progress-cancel-`);
  let release!: () => void, slowStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { slowStarted = resolve; });
  const api = await createApp({ dataDir, provider: { ...fixture, async translate(segments) {
    if (segments[0]!.text === 'Slow source') { slowStarted(); await gate; }
    return segments.map(segment => ({ ...segment, text: `Translated: ${segment.text}` }));
  } } });
  const server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { jobId } = await fetch(`${base}/api/translation-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr', segments: [{ id: 'fast', text: 'Fast source' }, { id: 'slow', text: 'Slow source' }] }) }).then(result => result.json());
    await started;
    let progress;
    for (let attempt = 0; attempt < 100; attempt++) {
      progress = await fetch(`${base}/api/jobs/${jobId}`).then(result => result.json());
      if (progress.completed === 1) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(progress.status, 'running'); assert.equal(progress.result.results[0].id, 'fast');
    await fetch(`${base}/api/jobs/${jobId}/cancel`, { method: 'POST' }); release();
    await new Promise(resolve => setTimeout(resolve, 20));
    const cancelled = await fetch(`${base}/api/jobs/${jobId}`).then(result => result.json());
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.completed, 1);
    assert.deepEqual(cancelled.result, progress.result);
  } finally { release(); api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('documents use the provider batch capacity instead of a fixed eight-block serial loop', async () => {
  const dataDir = await mkdtemp(`${tmpdir()}/oit-document-batch-`);
  const batches: number[] = [];
  const api = await createApp({ dataDir, provider: { ...fixture, batch: { maxSegments: 32, maxCharacters: 12000 }, async translate(segments) {
    batches.push(segments.length);
    return segments.map(segment => ({ ...segment, text: `Translated: ${segment.text}` }));
  } } });
  const server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const source = Array.from({ length: 20 }, (_, i) => `Public document paragraph number ${i}.`).join('\n\n');
    const { document } = await fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'batch.txt' }, body: source }).then(response => response.json());
    const { jobId } = await fetch(`${base}/api/documents/${document.id}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetLanguage: 'fr' }) }).then(response => response.json());
    let job;
    for (let attempt = 0; attempt < 100; attempt++) {
      job = await fetch(`${base}/api/jobs/${jobId}`).then(response => response.json());
      if (job.status === 'completed' || job.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(job.status, 'completed'); assert.equal(job.completed, 20);
    assert.deepEqual(batches, [20]);
  } finally { api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});
