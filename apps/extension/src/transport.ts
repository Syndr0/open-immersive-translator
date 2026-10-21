import type { TranslationReply } from './engine';

export interface TranslationInput {
  segments: Array<{ id: string; text: string }>;
  targetLanguage: string;
  sourceLanguage: string;
}
export interface TranslationJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: TranslationReply;
  error?: string;
  completed?: number;
  total?: number;
}
type Send = (message: Record<string, unknown>) => Promise<any>;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function validatedReply(value: unknown, expected: Set<string>, complete: boolean): TranslationReply {
  if (!value || typeof value !== 'object' || !Array.isArray((value as TranslationReply).results) || !Array.isArray((value as TranslationReply).errors)) {
    throw new Error('The job has no valid translation result.');
  }
  const candidate = value as TranslationReply;
  const seen = new Set<string>();
  const checkId = (id: unknown) => {
    if (typeof id !== 'string' || !expected.has(id) || seen.has(id)) throw new Error('The job returned unknown, duplicate or overlapping segment IDs.');
    seen.add(id);
  };
  const results = candidate.results.map(result => {
    if (!result || typeof result !== 'object' || typeof result.text !== 'string' || !result.text.trim()) throw new Error('The job returned an invalid translation text.');
    checkId(result.id);
    return { id: result.id, text: result.text };
  });
  const errors = candidate.errors.map(error => {
    if (!error || typeof error !== 'object' || typeof error.message !== 'string' || !error.message.trim()) throw new Error('The job returned an invalid segment error.');
    checkId(error.id);
    return { id: error.id, message: error.message };
  });
  if (seen.size > expected.size || (complete && seen.size !== expected.size)) throw new Error('The job returned an invalid segment count.');
  return { results, errors };
}

/** Poll from the content context: each MV3 worker request is short, even for a slow local model. */
export async function translateThroughJobs(input: TranslationInput, signal: AbortSignal, send: Send, pollMs = 500, onProgress?: (reply: TranslationReply) => void): Promise<TranslationReply> {
  signal.throwIfAborted();
  const expected = new Set(input.segments.map(segment => segment.id));
  if (!expected.size || expected.size !== input.segments.length || input.segments.some(segment => typeof segment.id !== 'string' || !segment.id || typeof segment.text !== 'string')) throw new Error('Translation input must have unique valid segment IDs.');
  if (!Number.isFinite(pollMs) || pollMs < 0) throw new Error('Polling interval must be nonnegative.');
  let jobId: string | undefined;
  let complete = false;
  let interval = Math.min(Math.max(1, pollMs), 100);
  const maximumInterval = Math.min(Math.max(1, pollMs), 500);
  const settled = new Map<string, string>();
  const publish = (reply: TranslationReply) => {
    const values = new Map<string, string>([
      ...reply.results.map(result => [result.id, JSON.stringify(['result', result.text])] as const),
      ...reply.errors.map(error => [error.id, JSON.stringify(['error', error.message])] as const),
    ]);
    for (const [id, previous] of settled) {
      if (values.get(id) !== previous) throw new Error('The job changed or removed an already settled segment.');
    }
    const hasNew = values.size > settled.size;
    if (hasNew) {
      for (const [id, value] of values) settled.set(id, value);
      signal.throwIfAborted();
      // The callback owns its copy; mutations cannot corrupt validation of later polls.
      onProgress?.({ results: reply.results.map(result => ({ ...result })), errors: reply.errors.map(error => ({ ...error })) });
      interval = Math.min(Math.max(1, pollMs), 100);
    }
  };
  try {
    const started = await send({ type: 'oit:translation-start', ...input });
    if (typeof started.jobId !== 'string') throw new Error('The server did not return a translation job.');
    jobId = started.jobId;
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const job = await send({ type: 'oit:translation-status', jobId }) as TranslationJob;
      signal.throwIfAborted();
      if (!job || typeof job !== 'object') throw new Error('The server returned an invalid translation job.');
      if (job.error !== undefined && typeof job.error !== 'string') throw new Error('The server returned an invalid translation job error.');
      if (job.total !== undefined && (!Number.isInteger(job.total) || job.total !== expected.size)) throw new Error('The job returned an invalid total segment count.');
      if (job.completed !== undefined && (!Number.isInteger(job.completed) || job.completed < 0 || job.completed > expected.size)) throw new Error('The job returned an invalid completed segment count.');
      if (job.status === 'completed') {
        const reply = validatedReply(job.result, expected, true);
        if (job.completed !== undefined && job.completed !== expected.size) throw new Error('The completed job returned an invalid segment count.');
        publish(reply);
        signal.throwIfAborted();
        complete = true;
        return reply;
      }
      if (!['queued', 'running', 'failed', 'cancelled'].includes(job.status)) throw new Error('The server returned an unknown translation job state.');
      if (job.result !== undefined) {
        const reply = validatedReply(job.result, expected, false);
        if (job.completed !== undefined && job.completed !== reply.results.length + reply.errors.length) throw new Error('The job progress count does not match its settled segments.');
        publish(reply);
      }
      signal.throwIfAborted();
      // A fatal failure can occur between polls after valid segments have settled.
      // Deliver that validated partial snapshot before surfacing the terminal error.
      if (job.status === 'failed') { complete = true; throw new Error(job.error || 'Translation job failed.'); }
      if (job.status === 'cancelled') { complete = true; throw new Error('Translation job was cancelled.'); }
      await delay(interval, signal);
      interval = Math.min(maximumInterval, Math.ceil(interval * 1.5));
    }
    throw new Error('Translation exceeded the 20-minute job limit. Try smaller paragraphs or a faster model.');
  } finally {
    if (jobId && !complete) await send({ type: 'oit:translation-cancel', jobId }).catch(() => {});
  }
}
