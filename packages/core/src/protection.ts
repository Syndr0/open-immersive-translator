const PROTECTED = /\[\[OIT_(?:OPEN|CLOSE|KEEP)_\d+\]\]|```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|https?:\/\/[^\s<>"']+/g;
const TOKEN = /⟪OIT_\d+⟫/g;

export interface ProtectedText { text: string; values: string[] }

export function protect(text: string): ProtectedText {
  if (text.match(TOKEN)) throw new Error('Source contains reserved translation tokens');
  const values: string[] = [];
  return { text: text.replace(PROTECTED, value => {
    const id = values.push(value) - 1;
    return `⟪OIT_${id}⟫`;
  }), values };
}

export function restore(text: string, protectedText: ProtectedText): string {
  const seen = new Map<string, number>();
  for (const token of text.match(TOKEN) ?? []) seen.set(token, (seen.get(token) ?? 0) + 1);
  if (seen.size !== protectedText.values.length || protectedText.values.some((_, i) => seen.get(`⟪OIT_${i}⟫`) !== 1)) {
    throw new Error('Provider changed or omitted a protected math/code/link token');
  }
  return text.replace(TOKEN, token => protectedText.values[Number(token.slice(5, -1))]!);
}

/** Split at natural boundaries, never through a protected identity or surrogate pair. */
export function splitText(text: string, maximum = 3500): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maximum) {
    let cut = maximum;
    const window = rest.slice(0, maximum);
    const natural = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
    if (natural > maximum / 2) cut = natural + 1;
    const open = rest.lastIndexOf('⟪', cut - 1), close = rest.lastIndexOf('⟫', cut - 1);
    if (open > close) cut = open;
    if (cut === 0) throw new Error('Protected token exceeds translation budget');
    if (/^[\uDC00-\uDFFF]$/.test(rest[cut] ?? '')) cut--;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [''];
}
