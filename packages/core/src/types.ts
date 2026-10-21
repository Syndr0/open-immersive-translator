export interface Segment { id: string; text: string }
export interface TranslationRequest {
  segments: Segment[];
  sourceLanguage?: string;
  targetLanguage: string;
}
export interface TranslationResult extends Segment { cached?: boolean }
export interface TranslationResponse {
  results: TranslationResult[];
  errors: { id: string; message: string }[];
  provider: string;
  model: string;
}
export interface DocumentBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'code' | 'table';
  text: string;
  page?: number;
  level?: number;
}
export interface SourceDocument {
  id: string;
  name: string;
  format: string;
  sourceHash: string;
  pageCount?: number;
  blocks: DocumentBlock[];
  warnings: string[];
  createdAt: string;
}
export interface DocumentTranslation {
  targetLanguage: string;
  units: Record<string, string>;
}
export interface TranslationJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  error?: string;
  result?: TranslationResponse;
}
export interface Provider {
  kind: string;
  model: string;
  configured: boolean;
  cacheNamespace?: string;
  /** Opt in to identified multi-segment calls; maxCharacters must be at least 2. */
  batch?: { maxSegments: number; maxCharacters: number };
  translate(segments: Segment[], source: string, target: string, signal: AbortSignal): Promise<Segment[]>;
}
export interface TranslationCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}
