import assert from 'node:assert/strict';
import test from 'node:test';
import { sameLanguage, translateNeeded, type Detection } from '../src/language';
import type { TranslationReply } from '../src/engine';

const controller = () => new AbortController();
const input = { sourceLanguage: 'auto', targetLanguage: 'en', segments: [{ id: 'en', text: 'English public source.' }, { id: 'zh', text: '这段中文需要翻译。' }] };
const detected = (language: string): Detection => ({ isReliable: true, languages: [{ language, percentage: 100 }] });

test('language aliases compare conservatively and Chinese script conversion remains enabled', () => {
  assert.equal(sameLanguage('en-US', 'en'), true);
  assert.equal(sameLanguage('zh-CN', 'zh-Hans'), true);
  assert.equal(sameLanguage('zh_TW', 'zh-Hant'), true);
  for (const [source, target] of [['zh-Hant', 'zh-Hans'], ['zh', 'zh-Hans'], ['auto', 'en'], ['und', 'en'], ['en', 'fr'], ['bad tag!', 'en']]) assert.equal(sameLanguage(source!, target!), false);
});

test('mixed batches omit target-language text from provider work and retain cumulative progress', async () => {
  let submitted: typeof input | undefined;
  const progress: TranslationReply[] = [];
  const result = await translateNeeded(input, controller().signal, async (request, _signal, report) => {
    submitted = request;
    const reply = { results: [{ id: 'zh', text: 'This Chinese paragraph needs translation.' }], errors: [] };
    report?.(reply); return reply;
  }, reply => progress.push(reply), async text => detected(text.startsWith('English') ? 'en' : 'zh-CN'));
  assert.deepEqual(submitted!.segments, [input.segments[1]]);
  assert.deepEqual(progress[0], { results: [input.segments[0]], errors: [] });
  assert.deepEqual(progress[1], result);
  assert.equal(result.results.length, 2);
});

test('explicit same-language requests never call detection or provider', async () => {
  const result = await translateNeeded({ ...input, sourceLanguage: 'en-US' }, controller().signal, async () => { throw new Error('No provider call expected'); }, undefined, async () => { throw new Error('No detection expected'); });
  assert.deepEqual(result, { results: input.segments, errors: [] });
});

test('uncertain, mixed and ambiguous Chinese detection must not hide content', async () => {
  for (const detection of [undefined, { isReliable: false, languages: [{ language: 'en', percentage: 100 }] },
    { isReliable: true, languages: [{ language: 'en', percentage: 90 }] },
    { isReliable: true, languages: [{ language: 'en', percentage: 98 }, { language: 'zh', percentage: 2 }] }]) {
    let submitted = 0;
    await translateNeeded(input, controller().signal, async request => { submitted = request.segments.length; return { results: request.segments, errors: [] }; }, undefined, async () => detection);
    assert.equal(submitted, 2);
  }
  let submitted = 0;
  await translateNeeded({ ...input, targetLanguage: 'zh-Hans' }, controller().signal, async request => { submitted = request.segments.length; return { results: request.segments, errors: [] }; }, undefined, async () => detected('zh'));
  assert.equal(submitted, 2);
});

test('detector failures and timeouts fall back to translation without dropping inputs', async () => {
  for (const detect of [async () => { throw new Error('Unavailable'); }, () => new Promise<Detection>(() => {})]) {
    let submitted = 0;
    await translateNeeded(input, controller().signal, async request => { submitted = request.segments.length; return { results: request.segments, errors: [] }; }, undefined, detect);
    assert.equal(submitted, 2);
  }
});

test('Restore during detection cancels before provider submission or progress', async () => {
  const abort = controller();
  let progress = 0, submitted = 0;
  const pending = translateNeeded(input, abort.signal, async () => { submitted++; return { results: [], errors: [] }; }, () => { progress++; }, () => new Promise<Detection>(() => {}));
  abort.abort(new Error('Restored'));
  await assert.rejects(pending, /Restored/);
  assert.equal(progress, 0); assert.equal(submitted, 0);
});

test('local detection receives prose without inline identity tokens', async () => {
  let text = '';
  const source = { ...input, segments: [{ id: 'p', text: 'Read [[OIT_OPEN_0]]this research[[OIT_CLOSE_0]] and keep [[OIT_KEEP_1]].' }] };
  const result = await translateNeeded(source, controller().signal, async () => { throw new Error('No provider needed'); }, undefined, async value => { text = value; return detected('en'); });
  assert.equal(text, 'Read this research and keep .');
  assert.deepEqual(result.results, source.segments);
});
