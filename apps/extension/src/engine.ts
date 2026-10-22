import { OWNED, owned, paragraphCandidates, paragraphOwner, renderTranslation, scanParagraphs, serializeParagraph, type Serialization } from './dom';
import { createTranslationPresentation } from './presentation';

export interface TranslationReply {
  results: Array<{ id: string; text: string }>;
  errors: Array<{ id: string; message: string }>;
}
export interface PageStatus { state: 'idle' | 'translating' | 'ready'; total: number; translated: number; failed: number; pending: number; error?: string }
export interface EngineOptions {
  targetLanguage: string;
  theme: 'subtle' | 'accent';
  translate: (segments: Array<{ id: string; text: string }>, signal: AbortSignal, onProgress?: (reply: TranslationReply) => void) => Promise<TranslationReply>;
  onStatus?: (status: PageStatus) => void;
}
interface Paragraph {
  id: string;
  host: Element;
  source: Serialization;
  status: 'queued' | 'pending' | 'translated' | 'failed';
  visible: boolean;
  wrapper?: Element;
  error?: string;
}
interface ScanTask { generation: number; iterator: Generator<Element | null>; candidates: Set<Element>; timer?: ReturnType<typeof setTimeout> }

/** One frame owns this engine, its DOM references and cancellation generation. */
export class PageTranslator {
  private records = new Map<Element, Paragraph>();
  private generation = 0;
  private nextId = 0;
  private enabled = false;
  private busy = false;
  private pausedError?: string;
  private observer?: MutationObserver;
  private intersections?: IntersectionObserver;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private mutationTimer?: ReturnType<typeof setTimeout>;
  private dirty = new Set<Element>();
  private scans = new Map<Element, ScanTask>();
  private options?: EngineOptions;
  private controller = new AbortController();

  constructor(private document: Document) {}

  start(options: EngineOptions): void {
    this.restore();
    this.controller = new AbortController();
    this.options = options;
    this.enabled = true;
    const window = this.document.defaultView!;
    if (typeof window.IntersectionObserver === 'function') {
      this.intersections = new window.IntersectionObserver(entries => {
        for (const entry of entries) {
          const record = this.records.get(entry.target);
          if (record) record.visible = entry.isIntersecting;
        }
        this.schedule();
      }, { rootMargin: '1200px 0px' });
    }
    if (this.document.body) {
      this.refresh(this.document.body);
      // Discover the first reading region without waiting behind a large site menu.
      const reading = this.document.querySelector('main,article,[role="main"],#content');
      if (reading && reading !== this.document.body) this.refresh(reading);
    }
    this.observer = new window.MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (owned(mutation.target)) continue;
        if (mutation.type === 'childList') {
          const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
          if (nodes.length && nodes.every(owned)) continue;
        }
        const target = paragraphOwner(mutation.target) ?? this.document.body;
        if (target) this.dirty.add(target);
      }
      if (this.dirty.size && !this.mutationTimer) {
        this.mutationTimer = setTimeout(() => {
          this.mutationTimer = undefined;
          if (!this.enabled) return;
          for (const root of this.dirty) if (root.isConnected) this.refresh(root);
          this.dirty.clear();
          this.removeDetached();
        }, 250);
      }
    });
    if (this.document.documentElement) this.observer.observe(this.document.documentElement, {
      subtree: true, characterData: true, childList: true, attributes: true,
      attributeFilter: ['href', 'src', 'alt', 'title', 'translate', 'contenteditable', 'hidden', 'aria-hidden', 'class', 'style'],
    });
    this.report();
  }

  restore(): void {
    this.enabled = false;
    this.generation++;
    this.controller.abort(new Error('Page translation was restored or restarted.'));
    this.observer?.disconnect();
    this.intersections?.disconnect();
    clearTimeout(this.flushTimer);
    clearTimeout(this.mutationTimer);
    this.flushTimer = undefined;
    this.mutationTimer = undefined;
    this.dirty.clear();
    for (const task of this.scans.values()) clearTimeout(task.timer);
    this.scans.clear();
    for (const record of this.records.values()) record.wrapper?.remove();
    // Host applications can clone/replace a subtree containing our injected nodes.
    for (const element of this.document.querySelectorAll(`[${OWNED}="translation"],[${OWNED}="controls"]`)) element.remove();
    this.records.clear();
    this.busy = false;
    this.pausedError = undefined;
    this.report();
  }

  status(): PageStatus {
    const values = [...this.records.values()];
    const translated = values.filter(record => record.status === 'translated').length;
    const failed = values.filter(record => record.status === 'failed').length;
    const pending = values.length - translated - failed;
    const error = this.pausedError || values.find(record => record.status === 'failed')?.error;
    return { state: !this.enabled ? 'idle' : pending || this.scans.size ? 'translating' : 'ready', total: values.length, translated, failed, pending, ...(error ? { error } : {}) };
  }

  private removeDetached(): void {
    for (const [host, record] of this.records) {
      if (!this.inBody(host)) { record.wrapper?.remove(); this.records.delete(host); this.intersections?.unobserve(host); }
    }
    const registered = new Set([...this.records.values()].map(record => record.wrapper).filter(Boolean));
    for (const element of this.document.querySelectorAll(`[${OWNED}="translation"]`)) if (!registered.has(element)) element.remove();
    this.report();
  }

  private refresh(root: Element): void {
    // Discover and serialize within short tasks, allowing input and rendering on long pages.
    for (const [other, task] of this.scans) if (other === root || root.contains(other)) {
      clearTimeout(task.timer); this.scans.delete(other);
    }
    const task: ScanTask = { generation: this.generation, iterator: paragraphCandidates(root), candidates: new Set() };
    this.scans.set(root, task);
    const step = () => {
      if (!this.enabled || task.generation !== this.generation || this.scans.get(root) !== task) return;
      const started = performance.now();
      let visited = 0;
      while (true) {
        const item = task.iterator.next();
        if (item.done) {
          this.scans.delete(root);
          // A concurrent, smaller dirty-root scan may have discovered a new source.
          // Recheck absent owners before removing their current record.
          for (const [host, record] of this.records) {
            if ((root === host || root.contains(host)) && !task.candidates.has(host) && !scanParagraphs(host).includes(host)) {
              record.wrapper?.remove(); this.records.delete(host); this.intersections?.unobserve(host);
            }
          }
          this.schedule(); this.report();
          return;
        }
        const host = item.value;
        if (host && this.inBody(host)) {
          const source = serializeParagraph(host);
          if (source.sourceText.length >= 2 && /\p{L}/u.test(source.sourceText)) {
            task.candidates.add(host);
            const previous = this.records.get(host);
            if (previous?.source.signature !== source.signature) {
              previous?.wrapper?.remove();
              const box = host.getBoundingClientRect();
              const record: Paragraph = { id: `p${this.nextId++}`, host, source, status: 'queued',
                visible: !this.intersections || (box.top < (this.document.defaultView?.innerHeight ?? 800) + 1200 && box.bottom >= -1200) };
              this.records.set(host, record); this.intersections?.observe(host);
              if (this.pausedError) this.failParagraph(record, this.pausedError);
            }
          }
        }
        if (++visited >= 24 || performance.now() - started >= 8) break;
      }
      this.schedule(); this.report();
      task.timer = setTimeout(step, 0);
    };
    step();
  }

  private schedule(): void {
    if (!this.enabled || this.busy || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, 30);
  }

  private async flush(): Promise<void> {
    if (!this.enabled || this.busy || !this.options || this.pausedError) return;
    this.removeDetached();
    const generation = this.generation;
    const selected: Paragraph[] = [];
    let size = 0;
    // Reading content reaches the provider before short navigation labels.
    const queued = [...this.records.values()].filter(record => record.status === 'queued' && record.visible);
    const priority = (record: Paragraph) => {
      const host = record.host, box = host.getBoundingClientRect();
      let score = box.top >= (this.document.defaultView?.innerHeight ?? 800) || box.bottom < 0 ? 100 : 0;
      if (host.closest('main,article,[role="main"]')) score -= 10;
      if (/^H[1-6]$/.test(host.tagName)) score -= 5;
      else if (host.matches('p,blockquote,figcaption')) score -= 3;
      if (host.closest('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]')) score += 20;
      if (record.source.sourceText.length < 20 && !/^H[1-6]$/.test(host.tagName)) score += 3;
      return score;
    };
    const priorities = new Map(queued.map(record => [record, priority(record)]));
    queued.sort((a, b) => priorities.get(a)! - priorities.get(b)!);
    for (const record of queued) {
      if (record.status !== 'queued' || !record.visible) continue;
      if (record.source.text.length > 20000) {
        this.failParagraph(record, 'This paragraph is too long. Split it into smaller blocks.');
        continue;
      }
      if (selected.length && (selected.length >= 32 || size + record.source.text.length > 24000)) break;
      record.status = 'pending'; selected.push(record); size += record.source.text.length;
      const pending = this.wrapper(record);
      pending.setAttribute('data-oit-pending', 'true'); pending.setAttribute('aria-busy', 'true');
      const label = this.document.createElement('span'); label.className = 'oit-loading-label'; label.textContent = 'Translating…';
      pending.append(label);
    }
    this.report();
    if (!selected.length) return;
    this.busy = true;
    try {
      const result = await this.options.translate(selected.map(record => ({ id: record.id, text: record.source.text })), this.controller.signal,
        progress => { if (this.enabled && generation === this.generation) this.applyReply(selected, progress, false); });
      if (!this.enabled || generation !== this.generation) return;
      this.applyReply(selected, result, true);
    } catch (error) {
      if (!this.enabled || generation !== this.generation) return;
      // A dead service must not drain every queued/offscreen batch into failures.
      // Keep completed translations and wait for an explicit user retry.
      this.pausedError = (error instanceof Error ? error.message : 'Translation failed.').trim().slice(0, 600) || 'Translation failed.';
      for (const record of [...this.records.values()]) if ((record.status === 'queued' || record.status === 'pending') && this.current(record)) this.failParagraph(record, this.pausedError);
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.report();
        if ([...this.records.values()].some(record => record.status === 'queued' && record.visible)) this.schedule();
      }
    }
  }

  private applyReply(selected: Paragraph[], reply: TranslationReply, final: boolean): void {
    const expected = new Set(selected.map(record => record.id)), seen = new Set<string>();
    if (!reply || !Array.isArray(reply.results) || !Array.isArray(reply.errors)) throw new Error('The server returned an invalid translation result.');
    for (const item of [...reply.results, ...reply.errors]) {
      if (!item || typeof item.id !== 'string' || !expected.has(item.id) || seen.has(item.id)) throw new Error('The server returned duplicate or unknown paragraph IDs.');
      seen.add(item.id);
    }
    if (reply.results.some(item => typeof item.text !== 'string' || !item.text.trim()) || reply.errors.some(item => typeof item.message !== 'string')) throw new Error('The server returned an invalid paragraph result.');
    for (const record of selected) {
      if (record.status !== 'pending' || !this.current(record)) continue;
      const value = reply.results.find(item => item.id === record.id);
      const error = reply.errors.find(item => item.id === record.id);
      if (!value && !error && !final) continue;
      try {
        if (!value) throw new Error(error?.message ?? 'The server returned no translation.');
        const fragment = renderTranslation(record.source, value.text, this.document);
        const wrapper = this.wrapper(record);
        wrapper.replaceChildren(fragment); record.status = 'translated';
      } catch (cause) {
        this.failParagraph(record, cause instanceof Error ? cause.message : 'Translation failed.');
      }
    }
    this.report();
  }

  private current(record: Paragraph): boolean {
    if (!this.inBody(record.host) || this.records.get(record.host) !== record) return false;
    if (serializeParagraph(record.host).signature !== record.source.signature) {
      this.refresh(record.host);
      return false;
    }
    return true;
  }

  private wrapper(record: Paragraph): Element {
    // A document permits only one root element. Never insert a sibling beside
    // <html>, head metadata, or a portal another extension moved outside body.
    if (!this.inBody(record.host)) throw new Error('The source paragraph is outside the page body.');
    if (record.wrapper?.isConnected) {
      record.wrapper.removeAttribute('data-oit-pending'); record.wrapper.removeAttribute('aria-busy');
      record.wrapper.replaceChildren();
      return record.wrapper;
    }
    const { element, placement } = createTranslationPresentation(record.host);
    element.setAttribute(OWNED, 'translation');
    element.className = `oit-translation oit-${this.options?.theme ?? 'subtle'}`;
    element.setAttribute('lang', this.options?.targetLanguage ?? '');
    element.setAttribute('dir', /^(ar|he|fa|ur)(-|$)/.test(this.options?.targetLanguage ?? '') ? 'rtl' : 'auto');
    if (placement === 'append') record.host.append(element);
    else record.host.after(element);
    record.wrapper = element;
    return element;
  }

  private failParagraph(record: Paragraph, message: string): void {
    record.status = 'failed';
    record.error = message.trim().slice(0, 600) || 'Translation failed.';
    // Failure belongs in the single page control. Repeated inline errors change
    // website layout and provide no translated content to justify an overlay.
    record.wrapper?.remove();
    record.wrapper = undefined;
  }

  private inBody(host: Element): boolean {
    const body = this.document.body;
    return host.isConnected && !!body && (host === body || body.contains(host));
  }

  private report(): void { this.options?.onStatus?.(this.status()); }
}
