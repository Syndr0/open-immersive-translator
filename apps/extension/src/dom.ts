export const OWNED = 'data-oit-owned';
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'DD', 'DT', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'BODY']);
const SKIP = 'script,style,noscript,template,textarea,input,select,button,pre,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-oit-ignore]';
const PROTECTED = 'code,kbd,samp,math,.katex,.MathJax,mjx-container,svg,img';
const INLINE = new Set(['A', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SUB', 'SUP', 'MARK', 'SMALL']);
export const TOKEN = /\[\[OIT_(OPEN|CLOSE|KEEP)_(\d+)\]\]/g;

export interface Serialization {
  text: string;
  sourceText: string;
  /** Local identity includes protected contents/attributes that are opaque to the provider. */
  signature: string;
  templates: Map<number, Element>;
  protectedNodes: Map<number, Element>;
  tokens: string[];
}

export function owned(node: Node | null): boolean {
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  return !!element?.closest(`[${OWNED}]`);
}

function excluded(element: Element): boolean {
  return owned(element) || !!element.closest(SKIP);
}

function isBlock(element: Element): boolean {
  if (BLOCK_TAGS.has(element.tagName)) return true;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !!style && ['block', 'list-item', 'table-cell', 'flex', 'grid'].includes(style.display);
}

function hidden(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return true;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden') return true;
  }
  return false;
}

export function paragraphOwner(node: Node): Element | null {
  let element = node.nodeType === 1 ? node as Element : node.parentElement;
  while (element) {
    if (isBlock(element)) return element;
    element = element.parentElement;
  }
  return null;
}

/** Group nested inline text by its nearest layout block; never split link text into a separate request. */
export function scanParagraphs(root: Element): Element[] {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, 4);
  const result = new Set<Element>();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || excluded(parent) || parent.closest(PROTECTED)) continue;
    const owner = paragraphOwner(node);
    if (!owner || excluded(owner) || hidden(owner)) continue;
    result.add(owner);
  }
  return [...result].filter(element => {
    const value = serializeParagraph(element).sourceText.trim();
    return value.length >= 2 && /\p{L}/u.test(value);
  });
}

export function serializeParagraph(host: Element): Serialization {
  let next = 0;
  let sourceText = '';
  const templates = new Map<number, Element>();
  const protectedNodes = new Map<number, Element>();
  const visit = (node: Node): string => {
    if (node.nodeType === 3) { sourceText += node.textContent ?? ''; return node.textContent ?? ''; }
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    if (excluded(element) || (element !== host && isBlock(element))) return '';
    if (element.matches(PROTECTED)) {
      const id = next++;
      protectedNodes.set(id, element);
      sourceText += element.textContent || element.getAttribute('alt') || '';
      return `[[OIT_KEEP_${id}]]`;
    }
    if (element.tagName === 'BR') { sourceText += '\n'; return '\n'; }
    const content = () => [...element.childNodes].map(visit).join('');
    if (element !== host && INLINE.has(element.tagName)) {
      const id = next++;
      templates.set(id, element);
      return `[[OIT_OPEN_${id}]]${content()}[[OIT_CLOSE_${id}]]`;
    }
    return content();
  };
  const text = visit(host).trim();
  const signature = JSON.stringify([
    text,
    ['hidden', 'aria-hidden', 'translate', 'contenteditable'].map(name => [name, host.getAttribute(name)]),
    [...templates].map(([id, element]) => [id, element.tagName, element.getAttributeNames().map(name => [name, element.getAttribute(name)])]),
    [...protectedNodes].map(([id, element]) => [id, element.outerHTML]),
  ]);
  return { text, sourceText: sourceText.trim(), signature, templates, protectedNodes, tokens: text.match(TOKEN) ?? [] };
}

let cloneSequence = 0;
function safeClone(source: Element, deep: boolean): Element {
  const clone = source.cloneNode(deep) as Element;
  const ids = new Map<string, string>();
  if (deep) {
    const prefix = `oit-protected-${++cloneSequence}-`;
    for (const element of [clone, ...clone.querySelectorAll('[id]')]) {
      const id = element.getAttribute('id');
      if (id) ids.set(id, `${prefix}${ids.size}`);
    }
  }
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      if (name.startsWith('on') || name === 'contenteditable' || name === 'srcdoc') { element.removeAttribute(name); continue; }
      const value = element.getAttribute(name)!;
      if (name === 'id') {
        if (ids.has(value)) element.setAttribute(name, ids.get(value)!);
        else element.removeAttribute(name);
      } else if (['href', 'xlink:href'].includes(name) && value.startsWith('#') && ids.has(value.slice(1))) {
        element.setAttribute(name, `#${ids.get(value.slice(1))}`);
      } else if (name === 'aria-labelledby' || name === 'aria-describedby') {
        element.setAttribute(name, value.split(/\s+/).map(id => ids.get(id) ?? id).join(' '));
      } else if (value.includes('url(')) {
        element.setAttribute(name, value.replace(/url\(\s*(['"]?)#([^\s)'"#]+)\1\s*\)/g, (original, _quote: string, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : original));
      }
    }
    if (element.tagName.toUpperCase() === 'A') {
      const href = element.getAttribute('href') ?? '';
      try {
        if (!['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(href, source.ownerDocument.baseURI).protocol)) element.removeAttribute('href');
      } catch { element.removeAttribute('href'); }
      if (element.getAttribute('target') === '_blank') element.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return clone;
}

/** Provider output is parsed as text and a restricted token grammar, never as HTML. */
export function renderTranslation(serialization: Serialization, translated: string, document: Document): DocumentFragment {
  const expected = [...serialization.tokens].sort();
  const actual = (translated.match(TOKEN) ?? []).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('The translation changed protected inline markers.');
  if (/\[\[OIT_/.test(translated.replace(TOKEN, ''))) throw new Error('The translation contains an unknown inline marker.');
  const fragment = document.createDocumentFragment();
  const stack: Array<{ id: number; container: DocumentFragment | Element }> = [{ id: -1, container: fragment }];
  let last = 0;
  for (const match of translated.matchAll(TOKEN)) {
    stack.at(-1)!.container.append(document.createTextNode(translated.slice(last, match.index)));
    const [, kind, number] = match;
    const id = Number(number);
    if (kind === 'OPEN') {
      const source = serialization.templates.get(id);
      if (!source) throw new Error('Unknown inline element.');
      const element = safeClone(source, false);
      stack.at(-1)!.container.append(element);
      stack.push({ id, container: element });
    } else if (kind === 'CLOSE') {
      if (stack.length <= 1 || stack.at(-1)!.id !== id) throw new Error('Unbalanced translated inline elements.');
      stack.pop();
    } else {
      const source = serialization.protectedNodes.get(id);
      if (!source) throw new Error('Unknown protected element.');
      stack.at(-1)!.container.append(safeClone(source, true));
    }
    last = match.index! + match[0].length;
  }
  if (stack.length !== 1) throw new Error('Unclosed translated inline elements.');
  fragment.append(document.createTextNode(translated.slice(last)));
  return fragment;
}
