import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TranslationBroker } from '@oit/core';
import { providerFromEnv } from '../src/provider.ts';

const cases = [
  { kind: 'ollama', name: 'default Qwen3.5 model', expectedModel: 'qwen3.5:2b', modelOverride: undefined, expectedThink: false },
  { kind: 'ollama', name: 'configured Qwen3.5 variant', expectedModel: 'qwen3.5:4b', modelOverride: 'qwen3.5:4b', expectedThink: false },
  { kind: 'ollama', name: 'arbitrary configured model', expectedModel: 'gpt-oss:20b', modelOverride: 'gpt-oss:20b', expectedThink: undefined },
  { kind: 'compatible', name: 'configured compatible model', expectedModel: 'fixture-model', modelOverride: 'qwen3.5:2b', expectedThink: undefined },
] as const;

for (const { kind, name, expectedModel, modelOverride, expectedThink } of cases) {
  test(`${kind} ${name} preserves its structured HTTP contract and protected values`, async () => {
    const seen: Array<{ path: string; authorization?: string; input: {
      model?: unknown; stream?: unknown; think?: unknown; format?: unknown;
      response_format?: unknown; temperature?: unknown; options?: unknown;
      messages: Array<{ role: string; content: string }>;
    } }> = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const part of request) body += String(part);
        const input = JSON.parse(body);
        seen.push({ path: request.url!, authorization: request.headers.authorization, input });
        const payload = JSON.parse(input.messages[1].content);
        const content = JSON.stringify({ segments: payload.segments.map((segment: { id: string; text: string }) => ({ ...segment, text: `Bonjour: ${segment.text}` })) });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(kind === 'ollama' ? { message: { content } } : { choices: [{ message: { content } }] }));
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'Invalid fixture request' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const provider = providerFromEnv({ TRANSLATION_PROVIDER: kind, OLLAMA_BASE_URL: base, OLLAMA_MODEL: modelOverride, COMPATIBLE_BASE_URL: `${base}/v1`, COMPATIBLE_MODEL: 'fixture-model', COMPATIBLE_API_KEY: 'test-only-key' });
      const result = await new TranslationBroker(provider).translate({ segments: [{ id: 'sentence', text: 'Keep $E=mc^2$ and `code()`.' }], targetLanguage: 'fr' });
      assert.equal(result.errors.length, 0);
      assert.equal(result.results[0]!.text, 'Bonjour: Keep $E=mc^2$ and `code()`.');
      assert.equal(provider.model, expectedModel);
      assert.equal(seen.length, 1);
      const recorded = seen[0]!;
      assert.equal(recorded.path, kind === 'ollama' ? '/api/chat' : '/v1/chat/completions');
      assert.equal(recorded.authorization, kind === 'compatible' ? 'Bearer test-only-key' : undefined);
      assert.equal(recorded.input.model, expectedModel);
      assert.equal(recorded.input.stream, false);
      assert.equal(recorded.input.think, expectedThink);
      assert.deepEqual(recorded.input.messages.map(message => message.role), ['system', 'user']);
      if (kind === 'ollama') {
        assert.equal(recorded.input.format, 'json');
        assert.deepEqual(recorded.input.options, { temperature: 0 });
        assert.equal('response_format' in recorded.input, false);
        assert.equal('think' in recorded.input, expectedThink !== undefined);
      } else {
        assert.deepEqual(recorded.input.response_format, { type: 'json_object' });
        assert.equal(recorded.input.temperature, 0);
        assert.equal('think' in recorded.input, false);
        assert.equal('format' in recorded.input, false);
        assert.equal('options' in recorded.input, false);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
