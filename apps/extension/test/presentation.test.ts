import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTranslationPresentation, presentationFingerprint } from '../src/presentation';
import { renderTranslation, serializeParagraph } from '../src/dom';

const documentFor = (html: string) => new JSDOM(html, { url: 'https://example.com/' }).window.document;

test('heading translation captures typography, alignment and margins without copying source identity', () => {
  const document = documentFor('<h1 id="page-title" class="title" data-secret="local" style="font-family:Georgia;font-size:42px;font-weight:700;color:rgb(24,40,56);line-height:1.2;text-align:center;margin:12px 7px 20px">Page heading</h1>');
  const host = document.querySelector('h1')!;
  const originalHtml = host.outerHTML;
  const { element, placement } = createTranslationPresentation(host);
  assert.equal(placement, 'after');
  assert.equal(element.style.fontFamily, 'Georgia');
  assert.equal(element.style.fontSize, '42px');
  assert.equal(element.style.fontWeight, '700');
  assert.equal(element.style.color, 'rgb(24, 40, 56)');
  assert.equal(element.style.textAlign, 'center');
  assert.equal(element.style.marginLeft, '7px');
  assert.equal(element.style.marginBottom, '20px');
  assert.equal(element.getAttribute('role'), 'heading');
  assert.equal(element.getAttribute('aria-level'), '1');
  assert.equal(element.hasAttribute('id'), false);
  assert.equal(element.hasAttribute('class'), false);
  assert.equal(element.hasAttribute('data-secret'), false);
  element.textContent = '页面标题'; host.after(element);
  assert.equal(document.querySelector('h1'), host);
  assert.equal(host.outerHTML, originalHtml);
  element.remove(); assert.equal(host.outerHTML, originalHtml);
});

test('dark navigation links retain their computed appearance and use inline wrappers', () => {
  const document = documentFor('<style>nav a{color:rgb(250,250,250);font-family:Arial;font-size:15px;font-weight:600;text-decoration:underline}</style><nav style="background:rgb(20,30,40)"><a href="/news">Latest news</a></nav>');
  const host = document.querySelector('a')!;
  const serialization = serializeParagraph(host);
  const { element, placement } = createTranslationPresentation(host);
  assert.equal(element.tagName, 'SPAN');
  assert.equal(element.style.display, 'inline');
  assert.equal(placement, 'after');
  assert.equal(element.style.color, 'rgb(250, 250, 250)');
  assert.equal(element.style.fontWeight, '600');
  element.append(renderTranslation(serialization, serialization.text.replace('Latest news', '最新消息'), document));
  host.after(element);
  assert.equal(element.querySelector('a')?.getAttribute('href'), '/news');
  assert.equal((element.querySelector('a') as HTMLElement).style.color, 'rgb(250, 250, 250)');
  assert.equal(host.textContent, 'Latest news');
});

test('blockquote indentation remains in the matching block presentation', () => {
  const document = documentFor('<blockquote style="margin-left:40px;margin-right:35px;font-style:italic;color:rgb(55,55,55)">A quoted passage.</blockquote>');
  const host = document.querySelector('blockquote')!;
  const { element, placement } = createTranslationPresentation(host);
  assert.equal(placement, 'after');
  assert.equal(element.style.marginLeft, '40px');
  assert.equal(element.style.marginRight, '35px');
  assert.equal(element.style.fontStyle, 'italic');
  assert.equal(element.style.display, 'block');
});

test('list and table targets stay in their container instead of becoming invalid siblings', () => {
  const document = documentFor('<ul><li>List content</li></ul><table><tbody><tr><td>Cell content</td></tr></tbody></table>');
  for (const selector of ['li', 'td']) assert.equal(createTranslationPresentation(document.querySelector(selector)!).placement, 'append');
});

test('presentation signatures exclude dimensions and position changed by inserted translations', () => {
  const document = documentFor('<p style="width:200px;height:20px;position:relative;left:0px;font-size:16px">Stable source.</p>');
  const host = document.querySelector('p') as HTMLElement;
  const initial = presentationFingerprint(host);
  host.style.width = '400px'; host.style.height = '80px'; host.style.left = '25px'; host.style.marginBottom = '40px';
  assert.deepEqual(presentationFingerprint(host), initial);
  host.style.fontSize = '20px';
  assert.notDeepEqual(presentationFingerprint(host), initial);
});
