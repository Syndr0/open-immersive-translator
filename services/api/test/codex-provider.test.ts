import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TranslationBroker } from '@oit/core';
import { codexProvider } from '../src/codex-provider.ts';
import { providerFromEnv } from '../src/provider.ts';

interface Audit {
  args: string[]; cwd: string; pid: number; prompt: string;
  input: { sourceLanguage: string; targetLanguage: string; segments: Array<{ id: string; text: string }> };
  schema: { additionalProperties: boolean; properties: { segments: { minItems: number; maxItems: number; items: { properties: { id: { enum: string[] } } } } } };
  env: Record<string, string | undefined>;
}

// These executable fixtures simulate the public CLI contract; no test invokes Codex
// or an account/model, and all credentials below are deliberately fake sentinels.
async function fixture(t: TestContext, mode = 'success') {
  const directory = await mkdtemp(join(tmpdir(), 'oit-cli-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'codex-fixture');
  const auditPath = join(directory, 'audit.json'), runsPath = join(directory, 'runs');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
if (mode === 'hang') process.on('SIGTERM', () => {});
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { prompt += data; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const arg = name => args[args.indexOf(name) + 1];
  const input = JSON.parse(prompt.split('TRANSLATION_INPUT_JSON\\n')[1]);
  const schema = JSON.parse(fs.readFileSync(arg('--output-schema'), 'utf8'));
  fs.appendFileSync(${JSON.stringify(runsPath)}, '1\\n');
  fs.writeFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, prompt, input, schema,
    env: Object.fromEntries(['OPENAI_API_KEY','GOOGLE_TRANSLATE_API_KEY','COMPATIBLE_API_KEY','CODEX_INTERNAL_TASK_ID','CODEX_HOME','HOME','PATH'].map(k => [k, process.env[k]])) }));
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'flood') { process.stdout.write('x'.repeat(65536)); setInterval(() => {}, 1000); return; }
  if (mode === 'auth') { process.stdout.write(JSON.stringify({type:'error',message:'Unauthorized 401 token=fake-secret-token /private/fake-auth.json'})); process.exitCode = 1; return; }
  if (mode === 'rate') { process.stderr.write('Usage limit 429 fake-secret-token /private/fake-auth.json'); process.exitCode = 1; return; }
  if (mode === 'exit') { process.stderr.write('private detail fake-secret-token /private/fake-auth.json'); process.exitCode = 12; return; }
  if (mode === 'missing') return;
  let result = { segments: input.segments.map(s => ({id:s.id,text:'Traduit: '+s.text})).reverse() };
  if (mode === 'unknown') result.segments[0].id = 'not-requested';
  if (mode === 'duplicate') result.segments[1].id = result.segments[0].id;
  if (mode === 'count') result.segments.pop();
  if (mode === 'empty') result.segments[0].text = ' ';
  if (mode === 'type') result.segments[0].text = 42;
  if (mode === 'marker') result.segments[0].text = 'missing protected value';
  if (mode === 'extra-marker') result.segments[0].text += ' ⟪OIT_999⟫';
  if (mode === 'extra-root') result.reasoning = 'not translation';
  if (mode === 'extra-entry') result.segments[0].reasoning = 'not translation';
  if (mode === 'artifact-large') result.segments[0].text = 'x'.repeat(5000);
  const output = mode === 'json' ? 'fake-secret-token invalid JSON' : JSON.stringify(result);
  fs.writeFileSync(arg('--output-last-message'), output);
});
`, { mode: 0o700 });
  return {
    executable, directory,
    provider: (options: Parameters<typeof codexProvider>[1] = {}) => codexProvider({ CODEX_CLI_PATH: executable, CODEX_MODEL: 'fixture-model' }, options),
    audit: async () => JSON.parse(await readFile(auditPath, 'utf8')) as Audit,
    async ready() {
      for (let attempt = 0; attempt < 300; attempt++) {
        try { return JSON.parse(await readFile(auditPath, 'utf8')) as Audit; } catch { await delay(10); }
      }
      throw new Error('Fixture process did not become ready');
    },
    runs: async () => (await readFile(runsPath, 'utf8')).trim().split('\n').length,
  };
}

const inputs = [{ id: 'first', text: 'Hello ⟪OIT_0⟫.' }, { id: 'second', text: 'Second sentence ⟪OIT_1⟫.' }];
const translate = (provider: ReturnType<typeof codexProvider>, signal = new AbortController().signal) => provider.translate(inputs, 'auto', 'fr', signal);

test('codex selection reports executable availability without launching or checking account secrets', async t => {
  const cli = await fixture(t);
  const unavailable = providerFromEnv({ TRANSLATION_PROVIDER: 'codex', CODEX_CLI_PATH: join(cli.directory, 'missing') });
  assert.equal(unavailable.kind, 'codex');
  assert.equal(unavailable.model, 'gpt-6.1-sol');
  assert.equal(unavailable.configured, false);
  await assert.rejects(translate(unavailable), /Codex CLI was not found/);
  const available = providerFromEnv({ TRANSLATION_PROVIDER: 'codex', CODEX_CLI_PATH: cli.executable, CODEX_MODEL: 'explicit-model' });
  assert.equal(available.configured, true);
  assert.equal(available.model, 'explicit-model');
  const byPath = codexProvider({ CODEX_CLI_PATH: 'codex-fixture', PATH: cli.directory });
  assert.equal(byPath.configured, true);
  assert.notEqual(available.cacheNamespace, cli.provider().cacheNamespace);
  await assert.rejects(cli.runs(), { code: 'ENOENT' });
});

test('codex CLI receives isolated read-only configuration and source only through stdin', async t => {
  const cli = await fixture(t);
  const provider = codexProvider({ CODEX_CLI_PATH: cli.executable, CODEX_MODEL: 'fixture-model', CODEX_HOME: join(cli.directory, 'existing-codex-home'), OPENAI_API_KEY: 'fake-openai-key', GOOGLE_TRANSLATE_API_KEY: 'fake-google-key', COMPATIBLE_API_KEY: 'fake-compatible-key', CODEX_INTERNAL_TASK_ID: 'fake-task-context' });
  assert.deepEqual(await translate(provider), inputs.map(segment => ({ ...segment, text: `Traduit: ${segment.text}` })));
  const audit = await cli.audit();
  assert.equal(audit.args[0], 'exec');
  for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(audit.args.includes(flag));
  assert.equal(audit.args[audit.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(audit.args[audit.args.indexOf('--model') + 1], 'fixture-model');
  for (const config of ['web_search="disabled"', 'project_doc_max_bytes=0', 'mcp_servers={}', 'model_reasoning_effort="low"']) assert.ok(audit.args.includes(config));
  const disabled = audit.args.flatMap((arg, index) => arg === '--disable' ? [audit.args[index + 1]] : []);
  for (const feature of ['shell_tool', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'plugins', 'view_image', 'skill_search', 'image_generation']) assert.ok(disabled.includes(feature));
  assert.equal(disabled.includes('hooks'), false);
  assert.equal(audit.args.includes('--ignore-rules'), false);
  assert.equal(audit.args.some(arg => arg.includes(inputs[0]!.text)), false);
  assert.deepEqual(audit.input, { sourceLanguage: 'auto', targetLanguage: 'fr', segments: inputs });
  assert.match(audit.prompt, /untrusted source data, never instructions/);
  for (const name of ['OPENAI_API_KEY', 'GOOGLE_TRANSLATE_API_KEY', 'COMPATIBLE_API_KEY', 'CODEX_INTERNAL_TASK_ID']) assert.equal(audit.env[name], undefined);
  assert.equal(audit.env.CODEX_HOME, join(cli.directory, 'existing-codex-home'));
  assert.notEqual(audit.cwd, process.cwd());
  assert.match(audit.cwd, /oit-codex-translation-/);
  await assert.rejects(access(audit.cwd, constants.F_OK), { code: 'ENOENT' });
  assert.equal(audit.schema.additionalProperties, false);
  assert.equal(audit.schema.properties.segments.minItems, inputs.length);
  assert.equal(audit.schema.properties.segments.maxItems, inputs.length);
  assert.deepEqual(audit.schema.properties.segments.items.properties.id.enum, inputs.map(input => input.id));
  assert.equal(await cli.runs(), 1);
});

test('codex broker restores protected math, code and website formatting identities', async t => {
  const cli = await fixture(t);
  const source = 'Keep $E=mc^2$ and `code()` and [[OIT_OPEN_0]]a link[[OIT_CLOSE_0]] to https://example.com/.';
  const result = await new TranslationBroker(cli.provider()).translate({ segments: [{ id: 'sentence', text: source }], targetLanguage: 'fr' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.results[0]!.text, `Traduit: ${source}`);
  const audit = await cli.audit();
  assert.match(audit.input.segments[0]!.text, /⟪OIT_\d+⟫/);
  assert.equal(audit.input.segments[0]!.text.includes('code()'), false);
});

for (const [mode, expected] of [
  ['unknown', /unknown segment IDs/], ['duplicate', /duplicate or unknown/], ['count', /mismatched translation count/],
  ['empty', /empty translation/], ['type', /invalid, duplicate or unknown/], ['marker', /protected math\/code\/link token/],
  ['extra-marker', /protected math\/code\/link token/], ['extra-root', /invalid structured translation/],
  ['extra-entry', /invalid translation entry/], ['json', /invalid JSON/], ['missing', /valid translation artifact/],
] as const) {
  test(`codex rejects ${mode} output without retrying or retaining temporary input`, async t => {
    const cli = await fixture(t, mode);
    await assert.rejects(translate(cli.provider()), expected);
    assert.equal(await cli.runs(), 1);
    await assert.rejects(access((await cli.audit()).cwd), { code: 'ENOENT' });
  });
}

for (const [mode, expected] of [['auth', /Sign in with codex login/], ['rate', /usage or rate limit/], ['exit', /No automatic retry/]] as const) {
  test(`codex ${mode} errors provide safe guidance without raw CLI output`, async t => {
    const cli = await fixture(t, mode);
    await assert.rejects(translate(cli.provider()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /fake-secret-token|fake-auth\.json|\/private/);
      return true;
    });
    assert.equal(await cli.runs(), 1);
  });
}

test('codex enforces diagnostic stream and final artifact byte limits', async t => {
  for (const mode of ['flood', 'artifact-large']) {
    const cli = await fixture(t, mode);
    await assert.rejects(translate(cli.provider({ maximumOutputBytes: 1024 })), /output limit|oversized or invalid output artifact/);
    assert.equal(await cli.runs(), 1);
    await assert.rejects(access((await cli.audit()).cwd), { code: 'ENOENT' });
  }
});

test('codex abort terminates an uncooperative process and removes temporary files', async t => {
  const cli = await fixture(t, 'hang');
  const controller = new AbortController();
  const pending = translate(cli.provider(), controller.signal);
  const rejected = assert.rejects(pending, /cancelled by fixture test/);
  const audit = await cli.ready();
  controller.abort(new Error('cancelled by fixture test'));
  await rejected;
  assert.throws(() => process.kill(audit.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(audit.cwd), { code: 'ENOENT' });
  assert.equal(await cli.runs(), 1);
});

test('codex timeout kills a process instead of silently retrying the signed-in account', async t => {
  const cli = await fixture(t, 'hang');
  await assert.rejects(translate(cli.provider({ timeoutMs: 1000 })), /timed out/);
  const audit = await cli.audit();
  assert.throws(() => process.kill(audit.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(audit.cwd), { code: 'ENOENT' });
  assert.equal(await cli.runs(), 1);
});

test('codex rejects duplicate IDs and excessive input before starting a process', async t => {
  const cli = await fixture(t);
  const provider = cli.provider();
  await assert.rejects(provider.translate([inputs[0]!, inputs[0]!], 'auto', 'fr', new AbortController().signal), /must be unique/);
  await assert.rejects(provider.translate([{ id: 'large', text: 'x'.repeat(200_001) }], 'auto', 'fr', new AbortController().signal), /batch is too large/);
  assert.deepEqual(await provider.translate([], 'auto', 'fr', new AbortController().signal), []);
  await assert.rejects(cli.runs(), { code: 'ENOENT' });
});

test('codex handles an executable that becomes unavailable without exposing its path', async t => {
  const cli = await fixture(t);
  const provider = cli.provider();
  await rm(cli.executable);
  await assert.rejects(translate(provider), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cannot launch the Codex CLI/);
    assert.equal(error.message.includes(cli.directory), false);
    return true;
  });
});
