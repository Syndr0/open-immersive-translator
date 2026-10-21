import { OWNED, owned, paragraphOwner, renderTranslation, scanParagraphs, serializeParagraph, type Serialization } from './dom';

export interface TranslationReply {
  results: Array<{ id: string; text: string }>;
  errors: Array<{ id: string; message: string }>;
}
export interface PageStatus { state: 'idle' | 'translating' | 'ready'; total: number; translated: number; failed: number; pending: number }
export interface EngineOptions {
  targetLanguage: string;
  theme: 'subtle' | 'accent';
  translate: (segments: Array<{ id: string; text: string }>, signal: AbortSignal) => Promise<TranslationReply>;
  onStatus?: (status: PageStatus) => void;
}
interface Paragraph {
  id: string;
  host: Element;
  source: Serialization;
  status: 'queued' | 'pending' | 'translated' | 'failed';
  visible: boolean;
  wrapper?: Element;
}

/** One frame owns this engine, its DOM references and cancellation generation. */
export class PageTranslator {
  private records = new Map<Element, Paragraph>();
  private generation = 0;
  private nextId = 0;
  private enabled = false;
  private busy = false;
  private observer?: MutationObserver;
  private intersections?: IntersectionObserver;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private mutationTimer?: ReturnType<typeof setTimeout>;
  private dirty = new Set<Element>();
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
      }, { rootMargin: '300px 0px' });
    }
    if (this.document.body) this.refresh(this.document.body);
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
      attributeFilter: ['href', 'src', 'alt', 'title', 'translate', 'contenteditable', 'hidden', 'aria-hidden'],
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
    for (const record of this.records.values()) record.wrapper?.remove();
    this.records.clear();
    this.busy = false;
    this.report();
  }

  status(): PageStatus {
    const values = [...this.records.values()];
    const translated = values.filter(record => record.status === 'translated').length;
    const failed = values.filter(record => record.status === 'failed').length;
    const pending = values.length - translated - failed;
    return { state: !this.enabled ? 'idle' : pending ? 'translating' : 'ready', total: values.length, translated, failed, pending };
  }

  private removeDetached(): void {
    for (const [host, record] of this.records) {
      if (!host.isConnected) { record.wrapper?.remove(); this.records.delete(host); this.intersections?.unobserve(host); }
    }
    this.report();
  }

  private refresh(root: Element): void {
    // Reparse only a dirty layout root. Own translation subtrees are excluded by the scanner.
    const candidates = new Set(scanParagraphs(root));
    for (const host of candidates) {
      const source = serializeParagraph(host);
      const previous = this.records.get(host);
      if (previous?.source.signature === source.signature) continue;
      previous?.wrapper?.remove();
      const box = host.getBoundingClientRect();
      const record: Paragraph = {
        id: `p${this.nextId++}`, host, source, status: 'queued',
        visible: !this.intersections || (box.top < (this.document.defaultView?.innerHeight ?? 800) + 300 && box.bottom >= -300),
      };
      this.records.set(host, record);
      this.intersections?.observe(host);
    }
    // A source can become empty or non-translatable without being removed.
    for (const [host, record] of this.records) {
      if ((root === host || root.contains(host)) && !candidates.has(host)) {
        record.wrapper?.remove(); this.records.delete(host); this.intersections?.unobserve(host);
      }
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.enabled || this.busy || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, 30);
  }

  private async flush(): Promise<void> {
    if (!this.enabled || this.busy || !this.options) return;
    this.removeDetached();
    const generation = this.generation;
    const selected: Paragraph[] = [];
    let size = 0;
    for (const record of this.records.values()) {
      if (record.status !== 'queued' || !record.visible) continue;
      if (record.source.text.length > 20000) {
        record.status = 'failed';
        this.showError(record, 'This paragraph is too long. Split it into smaller blocks.');
        continue;
      }
      if (selected.length && (selected.length >= 8 || size + record.source.text.length > 12000)) break;
      record.status = 'pending'; selected.push(record); size += record.source.text.length;
    }
    this.report();
    if (!selected.length) return;
    this.busy = true;
    try {
      const result = await this.options.translate(selected.map(record => ({ id: record.id, text: record.source.text })), this.controller.signal);
      if (!this.enabled || generation !== this.generation) return;
      for (const record of selected) {
        if (!this.current(record)) continue;
        const value = result.results.find(item => item.id === record.id);
        try {
          if (!value) throw new Error(result.errors.find(item => item.id === record.id)?.message ?? 'The server returned no translation.');
          const fragment = renderTranslation(record.source, value.text, this.document);
          const wrapper = this.wrapper(record);
          wrapper.append(fragment);
          record.status = 'translated';
        } catch (error) {
          record.status = 'failed';
          this.showError(record, error instanceof Error ? error.message : 'Translation failed.');
        }
      }
    } catch (error) {
      if (!this.enabled || generation !== this.generation) return;
      for (const record of selected) if (this.current(record)) {
        record.status = 'failed';
        this.showError(record, error instanceof Error ? error.message : 'Translation failed.');
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.report();
        if ([...this.records.values()].some(record => record.status === 'queued' && record.visible)) this.schedule();
      }
    }
  }

  private current(record: Paragraph): boolean {
    if (!record.host.isConnected || this.records.get(record.host) !== record) return false;
    if (serializeParagraph(record.host).signature !== record.source.signature) {
      this.refresh(record.host);
      return false;
    }
    return true;
  }

  private wrapper(record: Paragraph): Element {
    record.wrapper?.remove();
    const element = this.document.createElement('div');
    element.setAttribute(OWNED, 'translation');
    element.className = `oit-translation oit-${this.options?.theme ?? 'subtle'}`;
    element.setAttribute('lang', this.options?.targetLanguage ?? '');
    element.setAttribute('dir', /^(ar|he|fa|ur)(-|$)/.test(this.options?.targetLanguage ?? '') ? 'rtl' : 'auto');
    if (['TD', 'TH', 'LI', 'DD', 'DT', 'BODY'].includes(record.host.tagName)) record.host.append(element);
    else record.host.after(element);
    record.wrapper = element;
    return element;
  }

  private showError(record: Paragraph, message: string): void {
    const element = this.wrapper(record);
    element.classList.add('oit-error');
    element.textContent = 'Translation unavailable';
    element.setAttribute('title', message);
  }

  private report(): void { this.options?.onStatus?.(this.status()); }
}
