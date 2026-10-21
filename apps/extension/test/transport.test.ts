import assert from 'node:assert/strict';
import test from 'node:test';
import { translateThroughJobs } from '../src/transport';

const input = { segments: [{ id: 'one', text: 'A source paragraph.' }], targetLanguage: 'fr', sourceLanguage: 'auto' };

test('translation transport polls short jobs and preserves per-segment errors', async () => {
  const messages: string[] = [];
  let polls = 0;
  const result = { results: [{ id: 'one', text: 'Un paragraphe.' }], errors: [{ id: 'two', message: 'Provider unavailable' }] };
  const translated = await translateThroughJobs({ ...input, segments: [...input.segments, { id: 'two', text: 'Another paragraph.' }] }, new AbortController().signal, async message => {
    messages.push(String(message.type));
    if (message.type === 'oit:translation-start') return { jobId: 'a-job' };
    return ++polls < 3 ? { status: 'running' } : { status: 'completed', result };
  }, 1);
  assert.deepEqual(translated, result);
  assert.deepEqual(messages, ['oit:translation-start', 'oit:translation-status', 'oit:translation-status', 'oit:translation-status']);
});

test('progress publishes cumulative validated segments once before the slow segment finishes', async () => {
  const two = { ...input, segments: [...input.segments, { id: 'two', text: 'Slow paragraph.' }] };
  const snapshots = [
    { results: [{ id: 'one', text: 'Premier.' }], errors: [] },
    { results: [{ id: 'one', text: 'Premier.' }], errors: [] },
    { results: [{ id: 'one', text: 'Premier.' }], errors: [{ id: 'two', message: 'Timed out' }] },
  ];
  const updates: unknown[] = [];
  let polls = 0;
  const result = await translateThroughJobs(two, new AbortController().signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'progress-job' };
    const index = polls++;
    assert.equal(updates.length, index === 0 ? 0 : 1);
    return { status: index < 2 ? 'running' : 'completed', completed: index < 2 ? 1 : 2, total: 2, result: snapshots[index] };
  }, 1, reply => updates.push(reply));
  assert.deepEqual(updates, [snapshots[0], snapshots[2]]);
  assert.deepEqual(result, snapshots[2]);
});

test('progress callback receives a copy and does not corrupt later cumulative validation', async () => {
  const two = { ...input, segments: [...input.segments, { id: 'two', text: 'Second paragraph.' }] };
  let polls = 0;
  const first = { results: [{ id: 'one', text: 'Premier.' }], errors: [] };
  const final = { results: [{ id: 'one', text: 'Premier.' }, { id: 'two', text: 'Deuxième.' }], errors: [] };
  const result = await translateThroughJobs(two, new AbortController().signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'copy-job' };
    return ++polls === 1 ? { status: 'running', result: first } : { status: 'completed', result: final };
  }, 1, reply => { reply.results[0]!.text = 'Callback mutation'; });
  assert.deepEqual(result, final);
  assert.equal(first.results[0]!.text, 'Premier.');
});

test('unknown, duplicate, overlapping, incomplete and malformed partial/final results fail before unsafe callbacks', async () => {
  const valid = { id: 'one', text: 'Premier.' };
  const invalid = [
    { status: 'running', result: { results: [{ id: 'unknown', text: 'Unknown' }], errors: [] } },
    { status: 'running', result: { results: [valid, valid], errors: [] } },
    { status: 'running', result: { results: [valid], errors: [{ id: 'one', message: 'Conflict' }] } },
    { status: 'running', result: { results: [{ id: 'one', text: 42 }], errors: [] } },
    { status: 'running', result: { results: [], errors: [{ id: 'one', message: null }] } },
    { status: 'running', completed: 0, result: { results: [valid], errors: [] } },
    { status: 'running', total: 2, result: { results: [valid], errors: [] } },
    { status: 'completed', result: { results: [], errors: [] } },
    { status: 'completed', result: { results: [{ id: 'unknown', text: 'Unknown' }], errors: [] } },
    { status: 'completed', result: { results: [valid, valid], errors: [] } },
    { status: 'completed', result: { results: [valid], errors: [{ id: 'one', message: 'Conflict' }] } },
  ];
  for (const job of invalid) {
    let callbacks = 0, cancelled = 0;
    await assert.rejects(translateThroughJobs(input, new AbortController().signal, async message => {
      if (message.type === 'oit:translation-start') return { jobId: 'invalid-job' };
      if (message.type === 'oit:translation-cancel') { cancelled++; return {}; }
      return job;
    }, 1, () => { callbacks++; }));
    assert.equal(callbacks, 0, JSON.stringify(job)); assert.equal(cancelled, 1);
  }
});

test('changed settled values are rejected and abort suppresses subsequent progress', async () => {
  const two = { ...input, segments: [...input.segments, { id: 'two', text: 'Slow paragraph.' }] };
  let polls = 0, callbacks = 0;
  await assert.rejects(translateThroughJobs(two, new AbortController().signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'changed-job' };
    if (message.type === 'oit:translation-cancel') return {};
    return { status: 'running', result: { results: [{ id: 'one', text: ++polls === 1 ? 'Original result' : 'Changed result' }], errors: [] } };
  }, 1, () => { callbacks++; }), /already settled/);
  assert.equal(callbacks, 1);
  const controller = new AbortController(); callbacks = 0;
  await assert.rejects(translateThroughJobs(two, controller.signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'aborted-progress-job' };
    if (message.type === 'oit:translation-cancel') return {};
    controller.abort(new Error('Restored before status returned'));
    return { status: 'running', result: { results: [{ id: 'one', text: 'Late output' }], errors: [] } };
  }, 1, () => { callbacks++; }), /Restored/);
  assert.equal(callbacks, 0);
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

test('terminal failed or cancelled jobs deliver valid partial results before throwing', async () => {
  const two = { ...input, segments: [...input.segments, { id: 'two', text: 'Slow paragraph.' }] };
  const partial = { results: [{ id: 'one', text: 'Premier.' }], errors: [] };
  for (const status of ['failed', 'cancelled']) {
    const updates: unknown[] = [];
    let cancelRequests = 0;
    await assert.rejects(translateThroughJobs(two, new AbortController().signal, async message => {
      if (message.type === 'oit:translation-start') return { jobId: 'terminal-partial-job' };
      if (message.type === 'oit:translation-cancel') { cancelRequests++; return {}; }
      return { status, completed: 1, total: 2, result: partial, error: 'Fatal provider failure' };
    }, 1, reply => updates.push(reply)), status === 'failed' ? /Fatal provider failure/ : /cancelled/);
    assert.deepEqual(updates, [partial]); assert.equal(cancelRequests, 0);
  }
});

test('corrupt terminal partial results never emit and terminal snapshots preserve cumulative immutability', async () => {
  const two = { ...input, segments: [...input.segments, { id: 'two', text: 'Slow paragraph.' }] };
  for (const status of ['failed', 'cancelled']) {
    for (const result of [
      { results: [{ id: 'unknown', text: 'Unsafe' }], errors: [] },
      { results: [{ id: 'one', text: 'One' }, { id: 'one', text: 'Duplicate' }], errors: [] },
      { results: [{ id: 'one', text: 'One' }], errors: [{ id: 'one', message: 'Overlap' }] },
    ]) {
      let callbacks = 0;
      await assert.rejects(translateThroughJobs(two, new AbortController().signal, async message => {
        if (message.type === 'oit:translation-start') return { jobId: 'corrupt-terminal-job' };
        if (message.type === 'oit:translation-cancel') return {};
        return { status, completed: result.results.length + result.errors.length, total: 2, result };
      }, 1, () => { callbacks++; }), /segment IDs/);
      assert.equal(callbacks, 0);
    }
  }
  let polls = 0, callbacks = 0;
  await assert.rejects(translateThroughJobs(two, new AbortController().signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'changed-terminal-job' };
    if (message.type === 'oit:translation-cancel') return {};
    const first = ++polls === 1;
    return { status: first ? 'running' : 'failed', result: { results: [{ id: 'one', text: first ? 'Original result' : 'Changed result' }], errors: [] } };
  }, 1, () => { callbacks++; }), /already settled/);
  assert.equal(callbacks, 1);
});

test('local Restore suppresses a terminal partial result', async () => {
  const controller = new AbortController();
  let callbacks = 0;
  await assert.rejects(translateThroughJobs(input, controller.signal, async message => {
    if (message.type === 'oit:translation-start') return { jobId: 'restored-terminal-job' };
    if (message.type === 'oit:translation-cancel') return {};
    controller.abort(new Error('Restored'));
    return { status: 'failed', completed: 1, total: 1, result: { results: [{ id: 'one', text: 'Late output' }], errors: [] } };
  }, 1, () => { callbacks++; }), /Restored/);
  assert.equal(callbacks, 0);
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
