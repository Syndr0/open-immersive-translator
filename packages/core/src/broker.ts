import { createHash } from 'node:crypto';
import { protect, restore, splitText } from './protection.ts';
import type { Provider, TranslationCache, TranslationRequest, TranslationResponse } from './types.ts';

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

  async translate(request: TranslationRequest, signal: AbortSignal = new AbortController().signal): Promise<TranslationResponse> {
    const response: TranslationResponse = { results: [], errors: [], provider: this.provider.kind, model: this.provider.model };
    // Share only within this request: callers with independent cancellation own independent work.
    const inFlight = new Map<string, Promise<string>>();
    const ids = new Set<string>();
    for (const segment of request.segments) {
      if (ids.has(segment.id)) throw new Error('Segment IDs must be unique');
      ids.add(segment.id);
    }
    await Promise.all(request.segments.map(async segment => {
      try {
        signal.throwIfAborted();
        if (!segment.text.trim()) { response.results.push({ ...segment, cached: true }); return; }
        const key = createHash('sha256').update(JSON.stringify(['v1', this.provider.cacheNamespace ?? this.provider.kind, this.provider.model, request.sourceLanguage ?? 'auto', request.targetLanguage, segment.text])).digest('hex');
        const cached = this.cache.get(key);
        if (cached !== undefined) { response.results.push({ id: segment.id, text: cached, cached: true }); return; }
        let pending = inFlight.get(key);
        if (!pending) {
          pending = (async () => {
            const encoded = protect(segment.text);
            const parts = splitText(encoded.text);
            const translated: string[] = [];
            for (let i = 0; i < parts.length; i++) {
              signal.throwIfAborted();
              const id = `${segment.id}:${i}`;
              const result = await this.withPermit(async () => {
                signal.throwIfAborted();
                const outputs = await this.provider.translate([{ id, text: parts[i]! }], request.sourceLanguage ?? 'auto', request.targetLanguage, signal);
                if (outputs.length !== 1 || outputs[0]?.id !== id || typeof outputs[0].text !== 'string' || !outputs[0].text.trim()) throw new Error('Provider returned missing, duplicate or mismatched segment IDs');
                return outputs[0].text;
              }, signal);
              translated.push(result);
            }
            signal.throwIfAborted();
            const text = restore(translated.join(''), encoded);
            this.cache.set(key, text);
            return text;
          })();
          inFlight.set(key, pending);
        }
        const text = await pending;
        signal.throwIfAborted();
        response.results.push({ id: segment.id, text, cached: false });
      } catch (error) {
        response.errors.push({ id: segment.id, message: error instanceof Error ? error.message : 'Translation failed' });
      }
    }));
    const order = new Map(request.segments.map((s, i) => [s.id, i]));
    response.results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return response;
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
