import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { TranslationBroker, protect, restore, type Provider, type TranslationJob } from '@oit/core';
import { Store } from './store.ts';
import { parseDocument } from './parser.ts';
import { providerFromEnv } from './provider.ts';
import { exportDocument } from './export.ts';

const language = z.string().trim().min(2).max(60).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, 'Use a language tag such as en, zh-Hans or auto');
const requestSchema = z.object({
  segments: z.array(z.object({ id: z.string().min(1).max(200), text: z.string().max(100_000) })).min(1).max(100),
  targetLanguage: language, sourceLanguage: language.optional(),
});
const translationSchema = z.object({ targetLanguage: language, sourceLanguage: language.optional() });
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const version = (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
const MAX_JOBS = 1000;

export async function createApp(options: { dataDir?: string; provider?: Provider; env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env || process.env;
  const store = new Store(options.dataDir || resolve(repoRoot, env.DATA_DIR || '.data'));
  await store.initialize();
  const provider = options.provider || providerFromEnv(env);
  const broker = new TranslationBroker(provider, store);
  const jobs = new Map<string, TranslationJob>();
  const controllers = new Map<string, AbortController>();
  const generations = new Map<string, number>();
  const activeTranslations = new Map<string, AbortController>();
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const hostname = request.hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) { response.status(403).json({ error: 'Only loopback hostnames are allowed' }); return; }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  const appPort = env.PORT || '8787';
  app.use(cors({ origin(origin, callback) {
    if (!origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || ['http://localhost:5173', 'http://127.0.0.1:5173', `http://localhost:${appPort}`, `http://127.0.0.1:${appPort}`].includes(origin)) callback(null, true);
    else callback(Object.assign(new Error('Origin is not allowed'), { status: 403 }));
  }, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '2mb' }));

  // Finished jobs are kept for status polling, then evicted oldest-first.
  function track(job: TranslationJob, controller: AbortController) {
    if (jobs.size >= MAX_JOBS) for (const id of jobs.keys()) { if (!controllers.has(id)) jobs.delete(id); if (jobs.size < MAX_JOBS * .9) break; }
    if (jobs.size >= MAX_JOBS) return false;
    jobs.set(job.id, job); controllers.set(job.id, controller);
    return true;
  }

  app.get('/api/health', (_request, response) => response.json({ ok: true, version, provider: { kind: provider.kind, model: provider.model, configured: provider.configured } }));
  app.post('/api/translate', async (request, response) => {
    const input = requestSchema.parse(request.body);
    if (input.segments.reduce((sum, segment) => sum + segment.text.length, 0) > 200_000) { response.status(400).json({ error: 'Request exceeds 200000 characters' }); return; }
    const result = await broker.translate(input);
    await store.flushCache(); response.json(result);
  });
  // Short start/status requests survive MV3 worker suspension and slow local models.
  app.post('/api/translation-jobs', (request, response) => {
    const input = requestSchema.parse(request.body);
    if (input.segments.reduce((sum, segment) => sum + segment.text.length, 0) > 200_000) { response.status(400).json({ error: 'Request exceeds 200000 characters' }); return; }
    const job: TranslationJob = { id: randomUUID(), status: 'queued', completed: 0, total: input.segments.length };
    const controller = new AbortController();
    if (!track(job, controller)) { response.status(429).json({ error: 'Too many active jobs' }); return; }
    response.status(202).json({ jobId: job.id });
    void (async () => {
      job.status = 'running';
      const result = await broker.translate(input, controller.signal, snapshot => {
        if (controller.signal.aborted || job.status !== 'running') return;
        job.result = snapshot;
        job.completed = snapshot.results.length + snapshot.errors.length;
      });
      controller.signal.throwIfAborted();
      await store.flushCache();
      controller.signal.throwIfAborted();
      job.result = result;
      job.completed = input.segments.length;
      job.status = 'completed';
    })().catch(error => {
      if (controller.signal.aborted) job.status = 'cancelled';
      else { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Translation failed'; }
    }).finally(() => controllers.delete(job.id));
  });
  app.post('/api/documents', express.raw({ type: 'application/octet-stream', limit: '25mb' }), async (request, response) => {
    if (!Buffer.isBuffer(request.body)) { response.status(415).json({ error: 'Upload raw bytes with Content-Type: application/octet-stream' }); return; }
    let name: string;
    try { name = decodeURIComponent(request.get('X-File-Name') || 'document.txt').split(/[\\/]/).pop()!.replace(/[\x00-\x1f]/g, '').slice(0, 200); }
    catch { response.status(400).json({ error: 'Invalid filename encoding' }); return; }
    const document = await parseDocument(name, request.body, env);
    await store.create(document, request.body);
    response.status(201).json({ document });
  });
  app.get('/api/documents', async (_request, response) => { response.json({ documents: await store.list() }); });
  app.get('/api/documents/:id', async (request, response) => {
    const record = await store.load(request.params.id);
    if (!record) { response.status(404).json({ error: 'Document not found' }); return; }
    const selected = typeof request.query.targetLanguage === 'string' ? request.query.targetLanguage : record.latestLanguage;
    response.json({ document: record.document, translations: selected ? record.translations[selected] : undefined });
  });
  app.delete('/api/documents/:id', async (request, response) => {
    const id = request.params.id;
    for (const [key, controller] of activeTranslations) if (key.startsWith(`${id}:`)) controller.abort(new Error('Document deleted'));
    if (!(await store.delete(id))) { response.status(404).json({ error: 'Document not found' }); return; }
    response.status(204).end();
  });
  app.get('/api/documents/:id/source', async (request, response) => {
    const record = await store.load(request.params.id);
    if (!record) { response.status(404).json({ error: 'Document not found' }); return; }
    response.setHeader('Content-Disposition', `${record.document.format === 'pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(record.document.name)}`);
    response.type(record.document.format === 'pdf' ? 'application/pdf' : 'application/octet-stream');
    response.sendFile(store.sourcePath(record.document.id));
  });
  app.post('/api/documents/:id/translate', async (request, response) => {
    const record = await store.load(request.params.id);
    if (!record) { response.status(404).json({ error: 'Document not found' }); return; }
    const input = translationSchema.parse(request.body);
    const translationKey = `${record.document.id}:${input.targetLanguage}`;
    activeTranslations.get(translationKey)?.abort(new Error('Superseded by a newer translation'));
    const generation = (generations.get(translationKey) || 0) + 1;
    generations.set(translationKey, generation);
    const blocks = record.document.blocks.filter(block => block.type !== 'code');
    const job: TranslationJob = { id: randomUUID(), status: 'queued', completed: 0, total: blocks.length };
    const controller = new AbortController();
    if (!track(job, controller)) { response.status(429).json({ error: 'Too many active jobs' }); return; }
    activeTranslations.set(translationKey, controller);
    // Each job owns its result overlay. Late/cancelled jobs cannot mutate a saved translation.
    const initial = { ...(record.translations[input.targetLanguage]?.units || {}) };
    response.status(202).json({ jobId: job.id });
    void (async () => {
      job.status = 'running';
      const units = { ...initial };
      const failures: string[] = [];
      const batchSize = Math.max(1, Math.min(32, provider.batch?.maxSegments ?? 8));
      for (let offset = 0; offset < blocks.length; offset += batchSize) {
        controller.signal.throwIfAborted();
        const batch = blocks.slice(offset, offset + batchSize);
        const result = await broker.translate({ ...input, segments: batch.map(block => ({ id: block.id, text: block.text })) }, controller.signal);
        controller.signal.throwIfAborted();
        if (generations.get(translationKey) !== generation) throw new Error('Translation changed while this job was running; newer edits were preserved');
        for (const resultBlock of result.results) units[resultBlock.id] = resultBlock.text;
        failures.push(...result.errors.map(item => item.message));
        // Commit each successful batch so progress, partial failures and cancellation
        // keep already completed work. Reload to preserve other languages/edits.
        if (result.results.length) {
          const current = await store.load(record.document.id);
          if (!current) throw new Error('Document was deleted');
          controller.signal.throwIfAborted();
          if (generations.get(translationKey) !== generation) throw new Error('Translation changed while this job was running');
          current.translations[input.targetLanguage] = { targetLanguage: input.targetLanguage, units: { ...units } };
          current.latestLanguage = input.targetLanguage;
          await store.save(current);
        }
        job.completed += result.results.length + result.errors.length;
      }
      controller.signal.throwIfAborted();
      if (generations.get(translationKey) !== generation) throw new Error('Translation changed while this job was running; newer edits were preserved');
      await store.flushCache();
      if (failures.length) throw new Error(`${failures.length} blocks could not be translated. Completed translations were saved. ${failures[0]}`);
      job.status = 'completed';
    })().catch(error => {
      if (controller.signal.aborted) job.status = 'cancelled';
      else { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Translation failed'; }
    }).finally(() => { controllers.delete(job.id); if (activeTranslations.get(translationKey) === controller) activeTranslations.delete(translationKey); });
  });
  app.get('/api/jobs/:id', (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) { response.status(404).json({ error: 'Job not found; jobs are session-local and do not survive an API restart' }); return; }
    response.json(job);
  });
  // An agent can supply its own translations without a separate model/API account.
  // Validate the entire batch before cancelling work or changing any saved value.
  app.post('/api/documents/:id/translations', async (request, response) => {
    const input = z.object({
      targetLanguage: language,
      segments: z.array(z.object({ id: z.string().min(1).max(200), text: z.string().min(1).max(100_000) })).min(1).max(100),
    }).parse(request.body);
    if (input.segments.reduce((sum, segment) => sum + segment.text.length, 0) > 200_000) {
      response.status(400).json({ error: 'Translation batch exceeds 200000 characters' }); return;
    }
    const record = await store.load(request.params.id);
    if (!record) { response.status(404).json({ error: 'Document not found' }); return; }
    const blocks = new Map(record.document.blocks.map(block => [block.id, block]));
    const seen = new Set<string>();
    const validated: Record<string, string> = {};
    for (const segment of input.segments) {
      const block = blocks.get(segment.id);
      if (!block || block.type === 'code' || seen.has(segment.id)) {
        response.status(400).json({ error: 'Use unique IDs of translatable document blocks' }); return;
      }
      if (!segment.text.trim()) { response.status(400).json({ error: 'Translations must not be blank' }); return; }
      seen.add(segment.id);
      validated[segment.id] = restore(segment.text, protect(block.text));
    }
    const translationKey = `${record.document.id}:${input.targetLanguage}`;
    generations.set(translationKey, (generations.get(translationKey) || 0) + 1);
    activeTranslations.get(translationKey)?.abort(new Error('Agent translations saved; pending job cancelled to preserve edits'));
    // Reload after validation to merge translations saved for other languages.
    const current = (await store.load(record.document.id))!;
    current.translations[input.targetLanguage] = {
      targetLanguage: input.targetLanguage,
      units: { ...(current.translations[input.targetLanguage]?.units || {}), ...validated },
    };
    current.latestLanguage = input.targetLanguage;
    await store.save(current);
    const translatable = current.document.blocks.filter(block => block.type !== 'code');
    const translated = translatable.filter(block => current.translations[input.targetLanguage]!.units[block.id] !== undefined).length;
    response.json({ documentId: current.document.id, targetLanguage: input.targetLanguage, method: 'agent', saved: seen.size, translated, total: translatable.length, complete: translated === translatable.length });
  });
  app.post('/api/jobs/:id/cancel', (request, response) => {
    const job = jobs.get(request.params.id);
    if (!job) { response.status(404).json({ error: 'Job not found' }); return; }
    if (job.status === 'queued' || job.status === 'running') { controllers.get(job.id)?.abort(new Error('Translation cancelled')); job.status = 'cancelled'; }
    response.json(job);
  });
  app.patch('/api/documents/:id/blocks/:blockId', async (request, response) => {
    const input = z.object({ text: z.string().max(100_000), targetLanguage: language }).parse(request.body);
    const record = await store.load(request.params.id);
    if (!record || !record.document.blocks.some(block => block.id === request.params.blockId)) { response.status(404).json({ error: 'Document block not found' }); return; }
    const translation = record.translations[input.targetLanguage] || { targetLanguage: input.targetLanguage, units: {} };
    const translationKey = `${record.document.id}:${input.targetLanguage}`;
    generations.set(translationKey, (generations.get(translationKey) || 0) + 1);
    activeTranslations.get(translationKey)?.abort(new Error('Translation edited; pending job cancelled to preserve your edit'));
    translation.units[request.params.blockId] = input.text;
    record.translations[input.targetLanguage] = translation; record.latestLanguage = input.targetLanguage;
    await store.save(record); response.json({ ok: true, translations: translation });
  });
  app.get('/api/documents/:id/export', async (request, response) => {
    const record = await store.load(request.params.id);
    if (!record) { response.status(404).json({ error: 'Document not found' }); return; }
    const selected = typeof request.query.targetLanguage === 'string' ? request.query.targetLanguage : record.latestLanguage || 'unknown';
    const format = request.query.format === 'md' ? 'md' : 'html';
    const mode = request.query.mode === 'translated' ? 'translated' : 'bilingual';
    const units = record.translations[selected]?.units || {};
    const missing = record.document.blocks.filter(block => block.type !== 'code' && units[block.id] === undefined);
    if (missing.length && request.query.allowPartial !== 'true') { response.status(409).json({ error: `${missing.length} blocks are untranslated. Complete translation or explicitly export with allowPartial=true.` }); return; }
    response.type(format === 'md' ? 'text/markdown' : 'text/html');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${record.document.name}.${selected}.${format}`)}`);
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    response.send(exportDocument(record, selected, format, mode));
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found' }));
  const reader = resolve(repoRoot, 'apps/reader/dist');
  if (existsSync(reader)) {
    app.use(express.static(reader));
    app.get('/{*path}', (_request, response) => response.sendFile(resolve(reader, 'index.html')));
  }
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) { response.status(400).json({ error: 'Invalid request', details: error.issues.map(issue => ({ path: issue.path, message: issue.message })) }); return; }
    const status = (error as { status?: number }).status;
    if (status && status >= 500) console.error(error);
    response.status(status && status >= 400 && status < 600 ? status : 400).json({ error: error instanceof Error ? error.message : 'Request failed' });
  });
  return { app, store, broker, jobs, close: () => { for (const controller of controllers.values()) controller.abort(new Error('Server shutting down')); } };
}
