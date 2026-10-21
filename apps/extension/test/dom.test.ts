import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { paragraphCandidates, renderTranslation, scanParagraphs, serializeParagraph } from '../src/dom';
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

test('hidden inline descendants never enter a visible paragraph or its translation', () => {
  const document = documentFor('<style>#source .secret-label{display:none}</style><p id="source">Visible <span style="display:none">display secret</span><span style="visibility:hidden">visibility secret</span><span aria-hidden="true">ARIA secret</span><span class="secret-label">selector secret</span>words <a href="/safe"><span hidden>hidden link label</span>read more</a>.</p>');
  const original = document.querySelector('p')!;
  const originalHtml = original.innerHTML;
  const value = serializeParagraph(original);
  assert.equal(value.sourceText, 'Visible words read more.');
  for (const text of ['display secret', 'visibility secret', 'ARIA secret', 'selector secret', 'hidden link label']) assert.equal(value.text.includes(text), false);
  const holder = document.createElement('div'); holder.append(renderTranslation(value, value.text, document));
  assert.equal(holder.textContent, 'Visible words read more.');
  assert.equal(holder.querySelector('a')?.getAttribute('href'), '/safe');
  assert.equal(original.innerHTML, originalHtml);
});

test('screen reader labels and offscreen skip links are omitted without dropping ordinary below-fold prose', () => {
  const document = documentFor('<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)}.clip-path{position:absolute;width:1px;height:1px;clip-path:inset(50%)}</style><a href="#main" style="position:absolute;top:-40px">Skip to main</a><a href="#content" style="position:fixed;transform:translateY(-100%)">Skip to content</a><p>Visible words <span class="sr-only">screen reader duplicate</span><span class="clip-path">clipped label</span><span style="position:absolute;left:-9999px">offscreen label</span>remain.</p><p style="margin-top:9000px">Ordinary below-fold prose</p>');
  assert.deepEqual(scanParagraphs(document.body).map(element => serializeParagraph(element).sourceText), ['Visible words remain.', 'Ordinary below-fold prose']);
});

test('coinstalled Immersive Translate targets and controls are skipped while its original source is retained', () => {
  const document = documentFor('<p id="immersive-translate-original-0" class="immersive-translate-original">Original paragraph <font class="immersive-translate-target-wrapper"><font class="immersive-translate-target-inner">Injected translation</font></font> stays.</p><div id="immersive-translate-popup">Extension controls</div><div data-immersive-translate-target>Another target</div>');
  const original = document.querySelector('p')!;
  const html = original.innerHTML;
  assert.deepEqual(scanParagraphs(document.body).map(element => serializeParagraph(element).sourceText), ['Original paragraph  stays.']);
  assert.equal(original.innerHTML, html);
  assert.equal(original.querySelector('.immersive-translate-target-inner')?.textContent, 'Injected translation');
});

test('incremental candidate discovery yields heartbeats through large excluded trees', () => {
  const document = documentFor(`<pre>${Array.from({ length: 300 }, () => '<span>excluded text</span>').join('')}</pre><p>Visible paragraph.</p>`);
  const candidates = [...paragraphCandidates(document.body)];
  assert.ok(candidates.filter(value => value === null).length >= 2);
  assert.deepEqual(candidates.filter(Boolean), [document.querySelector('p')]);
});

test('host class/style and inherited typography changes invalidate source signatures', () => {
  const document = documentFor('<style>.larger p{font-size:28px}</style><div><p>Same source text.</p></div>');
  const host = document.querySelector('p')!;
  const first = serializeParagraph(host);
  host.className = 'new-host-class';
  const second = serializeParagraph(host);
  assert.notEqual(first.signature, second.signature);
  (host as HTMLElement).style.textAlign = 'center';
  const third = serializeParagraph(host);
  assert.notEqual(second.signature, third.signature);
  host.parentElement!.className = 'larger';
  assert.notEqual(third.signature, serializeParagraph(host).signature);
  assert.equal(first.sourceText, serializeParagraph(host).sourceText);
});

test('block-level root links retain safe destinations without copying arbitrary attributes', () => {
  const document = documentFor('<nav><a id="source-link" class="menu" data-private="value" style="display:block;color:white;font-weight:600" href="/news">Latest news</a></nav>');
  const source = document.querySelector('a')!;
  const html = source.outerHTML;
  const value = serializeParagraph(source);
  const holder = document.createElement('div'); holder.append(renderTranslation(value, value.text.replace('Latest news', '最新消息'), document));
  const clone = holder.querySelector('a')!;
  assert.equal(clone.getAttribute('href'), '/news');
  assert.equal(clone.hasAttribute('id'), false);
  assert.equal(clone.hasAttribute('class'), false);
  assert.equal(clone.hasAttribute('data-private'), false);
  assert.equal(clone.style.color, 'rgb(255, 255, 255)');
  assert.equal(clone.style.fontWeight, '600');
  assert.equal(source.outerHTML, html);
});

test('hidden code labels are not revealed when protected code is cloned outside its source selector', () => {
  const document = documentFor('<style>#source code .label{display:none}</style><p id="source">Keep <code>x=1<span class="label">hidden duplicate</span></code> unchanged.</p>');
  const host = document.querySelector('p')!;
  const value = serializeParagraph(host);
  const holder = document.createElement('div'); holder.append(renderTranslation(value, value.text, document));
  assert.equal(holder.querySelector('code')?.textContent, 'x=1');
  assert.equal(host.querySelector('code')?.textContent, 'x=1hidden duplicate');
});
