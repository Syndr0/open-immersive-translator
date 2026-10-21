import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderTranslation, scanParagraphs, serializeParagraph } from '../src/dom';
import { loopbackUrl } from '../src/settings';

const documentFor = (html: string) => new JSDOM(html, { url: 'https://example.com/' }).window.document;

test('one paragraph retains sentence context across links and emphasis', () => {
  const document = documentFor('<p>Read <a href="/article">this <em>article</em></a> now.</p><h2>Next heading</h2>');
  const paragraphs = scanParagraphs(document.body);
  assert.equal(paragraphs.length, 2);
  const value = serializeParagraph(paragraphs[0]);
  assert.equal(value.sourceText, 'Read this article now.');
  assert.equal(value.text, 'Read [[OIT_OPEN_0]]this [[OIT_OPEN_1]]article[[OIT_CLOSE_1]][[OIT_CLOSE_0]] now.');
});

test('nested layout blocks are independently owned without duplicate parent content', () => {
  const document = documentFor('<div>Outer words<p>Inner words <span>with inline text</span></p></div>');
  const paragraphs = scanParagraphs(document.body);
  assert.deepEqual(paragraphs.map(node => serializeParagraph(node).sourceText), ['Outer words', 'Inner words with inline text']);
});

test('exclusions and hidden content do not enter translation', () => {
  const document = documentFor('<p>Visible words</p><pre>const code = true</pre><p translate="no">Leave me</p><div contenteditable="true">Editing text</div><p hidden>Secret words</p><p>1234</p><button>Click here</button>');
  assert.deepEqual(scanParagraphs(document.body).map(node => serializeParagraph(node).sourceText), ['Visible words']);
});

test('safe rendering allows reordering, keeps local attributes and never parses provider HTML', () => {
  const document = documentFor('<p>Read <a href="/article" target="_blank" onclick="bad()" id="source">article</a> and <code>x += 1</code>.</p>');
  const value = serializeParagraph(document.querySelector('p')!);
  const fragment = renderTranslation(value, '[[OIT_KEEP_1]] — [[OIT_OPEN_0]]文章[[OIT_CLOSE_0]] <img src=x onerror=bad()>', document);
  const holder = document.createElement('div'); holder.append(fragment);
  assert.equal(holder.querySelector('code')?.textContent, 'x += 1');
  const link = holder.querySelector('a')!;
  assert.equal(link.getAttribute('href'), '/article');
  assert.equal(link.textContent, '文章');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.hasAttribute('onclick'), false);
  assert.equal(link.hasAttribute('id'), false);
  assert.equal(holder.querySelector('img'), null);
  assert.ok(holder.textContent?.includes('<img src=x onerror=bad()>'));
});

test('missing, duplicate, unknown and crossed markers are rejected', () => {
  const document = documentFor('<p><strong>Bold <em>words</em></strong><code>42</code></p>');
  const value = serializeParagraph(document.querySelector('p')!);
  assert.throws(() => renderTranslation(value, 'No markers', document), /markers/);
  assert.throws(() => renderTranslation(value, value.text + '[[OIT_KEEP_2]]', document), /markers/);
  assert.throws(() => renderTranslation(value, value.text + '[[OIT_OTHER_9]]', document), /unknown/);
  assert.throws(() => renderTranslation(value, '[[OIT_OPEN_0]][[OIT_OPEN_1]]wrong[[OIT_CLOSE_0]][[OIT_CLOSE_1]][[OIT_KEEP_2]]', document), /Unbalanced/);
});

test('original javascript link destinations are not copied into translated links', () => {
  const document = documentFor('<p>Read <a href="javascript:alert(1)">more</a></p>');
  const value = serializeParagraph(document.querySelector('p')!);
  const fragment = renderTranslation(value, value.text, document);
  assert.equal(fragment.querySelector('a')?.hasAttribute('href'), false);
});

test('settings accept only a loopback HTTP origin', () => {
  assert.equal(loopbackUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(loopbackUrl('http://localhost:5173'), 'http://localhost:5173');
  for (const bad of ['https://example.com', 'http://localhost.evil.com', 'http://localhost:8787/secret', 'http://user:pass@localhost']) assert.throws(() => loopbackUrl(bad));
});

test('protected SVG math remaps glyph IDs while retaining local references', () => {
  const document = documentFor('<p>Equation <svg><defs><path id="glyph" d="M0 0"/><clipPath id="clip"><path d="M0 0"/></clipPath></defs><use href="#glyph" clip-path="url(#clip)"/></svg> is protected.</p>');
  const value = serializeParagraph(document.querySelector('p')!);
  const fragment = renderTranslation(value, value.text, document);
  const cloned = fragment.querySelector('svg')!;
  const glyph = cloned.querySelector('defs path')!;
  assert.notEqual(glyph.id, 'glyph');
  assert.ok(glyph.id.startsWith('oit-protected-'));
  assert.equal(cloned.querySelector('use')!.getAttribute('href'), `#${glyph.id}`);
  assert.equal(cloned.querySelector('use')!.getAttribute('clip-path'), `url(#${cloned.querySelector('clipPath')!.id})`);
  assert.equal(document.querySelector('svg defs path')!.id, 'glyph');
});
