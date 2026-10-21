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

/** Poll from the content context: each MV3 worker request is short, even for a slow local model. */
export async function translateThroughJobs(input: TranslationInput, signal: AbortSignal, send: Send, pollMs = 500): Promise<TranslationReply> {
  signal.throwIfAborted();
  let jobId: string | undefined;
  let complete = false;
  try {
    const started = await send({ type: 'oit:translation-start', ...input });
    if (typeof started.jobId !== 'string') throw new Error('The server did not return a translation job.');
    jobId = started.jobId;
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const job = await send({ type: 'oit:translation-status', jobId }) as TranslationJob;
      signal.throwIfAborted();
      if (job.status === 'completed') {
        if (!job.result || !Array.isArray(job.result.results) || !Array.isArray(job.result.errors)) throw new Error('The completed job has no valid translation result.');
        complete = true;
        return job.result;
      }
      if (job.status === 'failed') { complete = true; throw new Error(job.error || 'Translation job failed.'); }
      if (job.status === 'cancelled') { complete = true; throw new Error('Translation job was cancelled.'); }
      if (!['queued', 'running'].includes(job.status)) throw new Error('The server returned an unknown translation job state.');
      await delay(pollMs, signal);
    }
    throw new Error('Translation exceeded the 20-minute job limit. Try smaller paragraphs or a faster model.');
  } finally {
    if (jobId && !complete) await send({ type: 'oit:translation-cancel', jobId }).catch(() => {});
  }
}
