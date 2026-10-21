import assert from 'node:assert/strict';
import test from 'node:test';
import { translateThroughJobs } from '../src/transport';

const input = { segments: [{ id: 'one', text: 'A source paragraph.' }], targetLanguage: 'fr', sourceLanguage: 'auto' };

test('translation transport polls short jobs and preserves per-segment errors', async () => {
  const messages: string[] = [];
  let polls = 0;
  const result = { results: [{ id: 'one', text: 'Un paragraphe.' }], errors: [{ id: 'two', message: 'Provider unavailable' }] };
  const translated = await translateThroughJobs(input, new AbortController().signal, async message => {
    messages.push(String(message.type));
    if (message.type === 'oit:translation-start') return { jobId: 'a-job' };
    return ++polls < 3 ? { status: 'running' } : { status: 'completed', result };
  }, 1);
  assert.deepEqual(translated, result);
  assert.deepEqual(messages, ['oit:translation-start', 'oit:translation-status', 'oit:translation-status', 'oit:translation-status']);
});

test('restore aborts polling and asks the server to cancel exactly once', async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  await assert.rejects(translateThroughJobs(input, controller.signal, async message => {
    messages.push(String(message.type));
    if (message.type === 'oit:translation-start') return { jobId: 'a-job' };
    if (message.type === 'oit:translation-status') { controller.abort(new Error('Restored')); return { status: 'running' }; }
    return { status: 'cancelled' };
  }, 1), /Restored/);
  assert.deepEqual(messages, ['oit:translation-start', 'oit:translation-status', 'oit:translation-cancel']);
});

test('fatal job failure is surfaced without leaking a pending job', async () => {
  let cancelled = false;
  await assert.rejects(translateThroughJobs(input, new AbortController().signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'a-job' };
    if (message.type === 'oit:translation-cancel') cancelled = true;
    return { status: 'failed', error: 'Start the translation provider.' };
  }, 1), /Start the translation provider/);
  assert.equal(cancelled, false);
});

test('a malformed completed result triggers cleanup instead of unsafe rendering', async () => {
  let cancelled = false;
  await assert.rejects(translateThroughJobs(input, new AbortController().signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'a-job' };
    if (message.type === 'oit:translation-cancel') { cancelled = true; return {}; }
    return { status: 'completed', result: { arbitrary: 'value' } };
  }, 1), /no valid translation result/);
  assert.equal(cancelled, true);
});
