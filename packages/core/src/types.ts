export interface Segment { id: string; text: string }
/** An adapter can fail one identified segment while retaining successful peers. */
export type ProviderResult = Segment | { id: string; error: string };
export interface TranslationRequest {
  segments: Segment[];
  sourceLanguage?: string;
  targetLanguage: string;
  /** Background for terminology (e.g. a paper's title and abstract); never translated itself. */
  context?: string;
}
export interface TranslationResult extends Segment { cached?: boolean }
export interface TranslationResponse {
  results: TranslationResult[];
  errors: { id: string; message: string }[];
  provider: string;
  model: string;
}
/**
 * figure: `asset` names a stored image; formula: `text` is LaTeX; table: `text`
 * is a Markdown pipe table; list: `marker` is the original bullet or number.
 */
export type BlockType = 'heading' | 'paragraph' | 'list' | 'caption' | 'reference' | 'footnote' | 'table' | 'code' | 'formula' | 'figure';
export interface DocumentBlock {
  id: string;
  type: BlockType;
  text: string;
  page?: number;
  level?: number;
  marker?: string;
  asset?: string;
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
  translate(segments: Segment[], source: string, target: string, signal: AbortSignal, context?: string): Promise<ProviderResult[]>;
}
export interface TranslationCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}
