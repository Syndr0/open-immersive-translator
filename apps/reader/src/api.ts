import type { DocumentBlock } from '@oit/core/document';

export type { DocumentBlock };

export interface ReadingDocument {
  id: string;
  name: string;
  format: string;
  sourceHash: string;
  pageCount?: number;
  blocks: DocumentBlock[];
  warnings: string[];
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  format: string;
  pageCount?: number;
  blockCount: number;
  createdAt: string;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface DocumentResponse {
  document: ReadingDocument;
  translations?: { targetLanguage: string; units: Record<string, string> };
}

export interface Health {
  ok: boolean;
  version: string;
  provider: { kind: string; model: string; configured: boolean };
}

export interface TranslationJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  error?: string;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.text();
    let message = `${response.status} ${response.statusText}`;
    try {
      const error = JSON.parse(body);
      message = typeof error.error === 'string' ? error.error : error.error?.message ?? error.message ?? message;
    } catch { /* Never render a server HTML error as markup. */ }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const jsonOptions = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const isAborted = (error: unknown) => error instanceof Error && error.name === 'AbortError';
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

const RECENT_KEY = 'oit.recent-document-ids.v1';
export function readRecentIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 12) : [];
  } catch { return []; }
}
export function writeRecentIds(ids: string[]): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([...new Set(ids)].slice(0, 12))); }
  catch { /* Reading still works when browser storage is unavailable. */ }
}
