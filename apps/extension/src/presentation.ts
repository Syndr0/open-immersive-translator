/** Only computed presentation values are copied; source attributes and IDs stay local. */
const TYPOGRAPHY = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'color', 'text-align',
  'text-transform', 'text-decoration-line', 'text-decoration-style',
  'text-decoration-color', 'white-space',
] as const;
const MARGINS = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] as const;

function computed(element: Element): CSSStyleDeclaration | undefined {
  return element.ownerDocument.defaultView?.getComputedStyle(element);
}

/** Also used for inline templates whose original ancestor selectors no longer match. */
export function copyTypography(source: Element, target: HTMLElement | SVGElement): void {
  const style = computed(source);
  if (!style) return;
  for (const property of TYPOGRAPHY) {
    const value = style.getPropertyValue(property);
    if (value) target.style.setProperty(property, value);
  }
}

export function presentationFingerprint(source: Element): string[] {
  const style = computed(source);
  // Layout geometry/margins may change when an owned sibling is inserted.
  return style ? [...TYPOGRAPHY, 'display'].map(property => style.getPropertyValue(property)) : [];
}

export interface TranslationPresentation {
  element: HTMLElement;
  placement: 'append' | 'after';
}

/** Capture before insertion so a new sibling cannot change the style being sampled. */
export function createTranslationPresentation(host: Element): TranslationPresentation {
  const style = computed(host);
  const display = style?.display ?? '';
  const inline = ['inline', 'inline-block', 'inline-flex', 'inline-grid'].includes(display)
    || (!display && ['A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'SMALL', 'LABEL'].includes(host.tagName));
  const element = host.ownerDocument.createElement(inline ? 'span' : 'div');
  element.setAttribute('data-oit-layout', inline ? 'inline' : 'block');
  if (/^H[1-6]$/.test(host.tagName)) {
    element.setAttribute('role', 'heading');
    element.setAttribute('aria-level', host.tagName.slice(1));
  }
  copyTypography(host, element);
  element.style.display = inline ? 'inline' : 'block';
  if (style) {
    for (const property of MARGINS) {
      const value = style.getPropertyValue(property);
      if (value) element.style.setProperty(property, value);
    }
    // A source-owned dark surface must not leave light text on a light page.
    const background = style.backgroundColor;
    if (background && background !== 'transparent' && !/^rgba\([^)]*,\s*0\s*\)$/.test(background)) element.style.backgroundColor = background;
  }
  // These containers need the translation in their existing table/list context.
  const placement = ['TD', 'TH', 'LI', 'DD', 'DT', 'BODY'].includes(host.tagName) ? 'append' : 'after';
  return { element, placement };
}
