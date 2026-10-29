import { createHash } from 'node:crypto';
import { protect, restore, splitText } from './protection.ts';
import type { Provider, ProviderResult, TranslationCache, TranslationRequest, TranslationResponse, TranslationResult } from './types.ts';

export class MemoryCache implements TranslationCache {
  private values = new Map<string, string>();
  constructor(private maximum = 10_000) {}
  get(key: string) { return this.values.get(key); }
  set(key: string, value: string) {
    this.values.delete(key); this.values.set(key, value);
    if (this.values.size > this.maximum) this.values.delete(this.values.keys().next().value!);
  }
}

export class TranslationBroker {
  private active = 0;
  private waiters: Array<{ ready: () => void; abort: () => void; signal: AbortSignal }> = [];
  constructor(readonly provider: Provider, private cache: TranslationCache = new MemoryCache(), private concurrency = 2) {}

  async translate(request: TranslationRequest, signal: AbortSignal = new AbortController().signal, onProgress?: (snapshot: TranslationResponse) => void): Promise<TranslationResponse> {
    const results = new Map<string, TranslationResult>();
    const errors = new Map<string, { id: string; message: string }>();
    const ids = new Set<string>();
    for (const segment of request.segments) {
      if (ids.has(segment.id)) throw new Error('Segment IDs must be unique');
      ids.add(segment.id);
    }
    const maxSegments = this.provider.batch?.maxSegments ?? 1;
    const maxCharacters = this.provider.batch?.maxCharacters ?? 3500;
    if (!Number.isSafeInteger(maxSegments) || maxSegments < 1 || !Number.isSafeInteger(maxCharacters) || maxCharacters < 2) throw new Error('Provider batch limits must be positive integers with at least 2 characters');
    const metadata = { provider: this.provider.kind, model: this.provider.model };
    const snapshot = (): TranslationResponse => ({ ...metadata,
      results: request.segments.flatMap(segment => { const result = results.get(segment.id); return result ? [{ ...result }] : []; }),
      errors: request.segments.flatMap(segment => { const error = errors.get(segment.id); return error ? [{ ...error }] : []; }),
    });
    const emit = () => {
      // Observers receive independent cumulative values and cannot fail translation.
      try { onProgress?.(snapshot()); } catch { /* An observer does not own provider work. */ }
    };
    interface Work {
      key: string; aliases: string[]; encoded: ReturnType<typeof protect>;
      parts: string[]; translated: Array<string | undefined>; remaining: number; settled: boolean;
    }
    interface Chunk { id: string; text: string; index: number; work: Work }
    // Deduplicate only inside this request. Independent callers own cancellation.
    const workByKey = new Map<string, Work>();
    const chunks: Chunk[] = [];
    const fail = (work: Work, error: unknown) => {
      if (work.settled) return;
      work.settled = true;
      for (const id of work.aliases) errors.set(id, { id, message: error instanceof Error ? error.message : 'Translation failed' });
      emit();
    };
    for (const segment of request.segments) {
      try {
        signal.throwIfAborted();
        if (!segment.text.trim()) { results.set(segment.id, { ...segment, cached: true }); emit(); continue; }
        const key = createHash('sha256').update(JSON.stringify(['v1', this.provider.cacheNamespace ?? this.provider.kind, this.provider.model, request.sourceLanguage ?? 'auto', request.targetLanguage, segment.text])).digest('hex');
        const cached = this.cache.get(key);
        if (cached !== undefined) { results.set(segment.id, { id: segment.id, text: cached, cached: true }); emit(); continue; }
        const existing = workByKey.get(key);
        if (existing) { existing.aliases.push(segment.id); continue; }
        const encoded = protect(segment.text);
        const parts = splitText(encoded.text, Math.min(3500, maxCharacters));
        const work: Work = { key, aliases: [segment.id], encoded, parts, translated: new Array(parts.length), remaining: parts.length, settled: false };
        workByKey.set(key, work);
        for (let index = 0; index < parts.length; index++) chunks.push({ id: `${segment.id}:${index}`, text: parts[index]!, index, work });
      } catch (error) {
        errors.set(segment.id, { id: segment.id, message: error instanceof Error ? error.message : 'Translation failed' }); emit();
      }
    }
    const batches: Chunk[][] = [];
    let batch: Chunk[] = [], characters = 0;
    for (const chunk of chunks) {
      if (batch.length && (batch.length >= maxSegments || characters + chunk.text.length > maxCharacters)) { batches.push(batch); batch = []; characters = 0; }
      batch.push(chunk); characters += chunk.text.length;
    }
    if (batch.length) batches.push(batch);
    await Promise.all(batches.map(async batch => {
      try {
        await this.withPermit(async () => {
          signal.throwIfAborted();
          const pending = batch.filter(chunk => !chunk.work.settled);
          if (!pending.length) return;
          const outputs = await this.provider.translate(pending.map(({ id, text }) => ({ id, text })), request.sourceLanguage ?? 'auto', request.targetLanguage, signal, request.context);
          signal.throwIfAborted();
          const expected = new Set(pending.map(chunk => chunk.id));
          const byId = new Map<string, ProviderResult>();
          if (!Array.isArray(outputs) || outputs.length !== pending.length) throw new Error('Provider returned missing, duplicate or mismatched segment IDs');
          for (const output of outputs) {
            if (!output || typeof output.id !== 'string' || !expected.has(output.id) || byId.has(output.id)) throw new Error('Provider returned missing, duplicate or mismatched segment IDs');
            if ('error' in output) {
              if (typeof output.error !== 'string' || !output.error.trim() || 'text' in output) throw new Error('Provider returned an invalid segment error');
            } else if (typeof output.text !== 'string' || !output.text.trim()) throw new Error('Provider returned missing, duplicate or mismatched segment IDs');
            byId.set(output.id, output);
          }
          for (const chunk of pending) {
            const work = chunk.work;
            if (work.settled) continue;
            try {
              const output = byId.get(chunk.id)!;
              if ('error' in output) throw new Error(output.error);
              const text = output.text;
              // Validate each identified chunk before combining the original block.
              const markers = (value: string) => JSON.stringify((value.match(/⟪OIT_\d+⟫/g) ?? []).sort());
              if (markers(text) !== markers(chunk.text)) throw new Error('Provider changed or omitted a protected math/code/link token');
              work.translated[chunk.index] = text; work.remaining--;
              if (!work.remaining) {
                const restored = restore(work.translated.join(''), work.encoded);
                signal.throwIfAborted();
                this.cache.set(work.key, restored); work.settled = true;
                for (const id of work.aliases) results.set(id, { id, text: restored, cached: false });
                emit();
              }
            } catch (error) { fail(work, error); }
          }
        }, signal);
      } catch (error) { for (const chunk of batch) fail(chunk.work, error); }
    }));
    return snapshot();
  }

  private async withPermit<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.concurrency) await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        ready: () => { signal.removeEventListener('abort', waiter.abort); resolve(); },
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    }); else this.active++;
    try { return await work(); }
    finally { const next = this.waiters.shift(); if (next) next.ready(); else this.active--; }
  }
}
