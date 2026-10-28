import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentTranslation, SourceDocument, TranslationCache } from '@oit/core';

export interface DocumentSummary {
  id: string;
  name: string;
  format: string;
  pageCount?: number;
  blockCount: number;
  createdAt: string;
}

export interface DocumentRecord {
  document: SourceDocument;
  translations: Record<string, DocumentTranslation>;
  latestLanguage?: string;
}

export class Store implements TranslationCache {
  private documents = new Map<string, DocumentRecord>();
  private cache = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();
  // A job that loaded a record before deletion must not write it back afterwards.
  private deleted = new Set<string>();
  constructor(readonly directory: string) {}
  async initialize() {
    await mkdir(join(this.directory, 'documents'), { recursive: true });
    await mkdir(join(this.directory, 'sources'), { recursive: true });
    try {
      const entries: [string, string][] = JSON.parse(await readFile(join(this.directory, 'cache.json'), 'utf8'));
      this.cache = new Map(entries.slice(-10_000));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read translation cache'); }
  }
  get(key: string) { return this.cache.get(key); }
  set(key: string, value: string) {
    this.cache.delete(key); this.cache.set(key, value);
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
  }
  async flushCache() { await this.atomic('cache.json', [...this.cache]); }
  async create(document: SourceDocument, source: Buffer) {
    const record: DocumentRecord = { document, translations: {} };
    await writeFile(this.sourcePath(document.id), source, { flag: 'wx' });
    await this.save(record);
    return record;
  }
  async load(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const cached = this.documents.get(id);
    if (cached) return cached;
    try {
      const record = JSON.parse(await readFile(join(this.directory, 'documents', `${id}.json`), 'utf8')) as DocumentRecord;
      this.documents.set(id, record); return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async list(): Promise<DocumentSummary[]> {
    const ids = (await readdir(join(this.directory, 'documents'))).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => name.slice(0, -5));
    const records = await Promise.all(ids.map(id => this.load(id).catch(() => undefined)));
    return records.filter((record): record is DocumentRecord => !!record)
      .map(({ document }) => ({ id: document.id, name: document.name, format: document.format, pageCount: document.pageCount, blockCount: document.blocks.length, createdAt: document.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async delete(id: string) {
    if (!(await this.load(id))) return false;
    this.deleted.add(id); this.documents.delete(id);
    await this.pending.catch(() => {});
    await rm(join(this.directory, 'documents', `${id}.json`), { force: true });
    await rm(this.sourcePath(id), { force: true });
    return true;
  }
  async save(record: DocumentRecord) {
    if (this.deleted.has(record.document.id)) return;
    this.documents.set(record.document.id, record);
    await this.atomic(join('documents', `${record.document.id}.json`), record);
  }
  sourcePath(id: string) { return join(this.directory, 'sources', `${id}.bin`); }
  private async atomic(relative: string, data: unknown) {
    const serialized = JSON.stringify(data);
    const operation = this.pending.catch(() => {}).then(async () => {
      const path = join(this.directory, relative), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialized, 'utf8');
      await rename(temporary, path);
    });
    this.pending = operation; await operation;
  }
}
