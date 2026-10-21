import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TranslationBroker } from '@oit/core';
import { providerFromEnv } from '../src/provider.ts';

for (const kind of ['ollama', 'compatible'] as const) {
  test(`${kind} adapter makes structured HTTP requests and restores protected values`, async () => {
    const seen: string[] = [];
    const server = createServer(async (request, response) => {
      seen.push(request.url!);
      let body = '';
      for await (const part of request) body += String(part);
      const input = JSON.parse(body);
      assert.equal(input.model, 'fixture-model');
      assert.equal(input.stream, false);
      assert.equal(request.headers.authorization, kind === 'compatible' ? 'Bearer test-only-key' : undefined);
      const payload = JSON.parse(input.messages[1].content);
      const content = JSON.stringify({ segments: payload.segments.map((segment: { id: string; text: string }) => ({ ...segment, text: `Bonjour: ${segment.text}` })) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(kind === 'ollama' ? { message: { content } } : { choices: [{ message: { content } }] }));
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const provider = providerFromEnv({ TRANSLATION_PROVIDER: kind, OLLAMA_BASE_URL: base, OLLAMA_MODEL: 'fixture-model', COMPATIBLE_BASE_URL: `${base}/v1`, COMPATIBLE_MODEL: 'fixture-model', COMPATIBLE_API_KEY: 'test-only-key' });
      const result = await new TranslationBroker(provider).translate({ segments: [{ id: 'sentence', text: 'Keep $E=mc^2$ and `code()`.' }], targetLanguage: 'fr' });
      assert.equal(result.errors.length, 0);
      assert.equal(result.results[0]!.text, 'Bonjour: Keep $E=mc^2$ and `code()`.');
      assert.deepEqual(seen, [kind === 'ollama' ? '/api/chat' : '/v1/chat/completions']);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
