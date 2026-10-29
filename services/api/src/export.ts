import katex from 'katex';
import { isTranslatable, parseTable, splitMath, type DocumentBlock } from '@oit/core';
import type { DocumentRecord } from './store.ts';

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

/** Exports are standalone files, so formulas become MathML that browsers render without fonts. */
const math = (latex: string, displayMode: boolean) => katex.renderToString(latex, { displayMode, throwOnError: false, output: 'mathml' });
const rich = (text: string) => splitMath(text).map(part => part.kind === 'text' ? escapeHtml(part.value).replace(/\n/g, '<br>') : math(part.value, part.display)).join('');

function tableHtml(text: string, translation?: string) {
  const rows = parseTable(text), other = translation === undefined ? undefined : parseTable(translation);
  const cell = (value: string, r: number, c: number) => {
    const translated = other?.[r]?.[c];
    return `${rich(value)}${translated && translated !== value ? `<span class="cell-translation">${rich(translated)}</span>` : ''}`;
  };
  return `<table>${rows.map((row, r) => `<tr>${row.map((value, c) => `<${r ? 'td' : 'th'}>${cell(value, r, c)}</${r ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
}

function blockHtml(block: DocumentBlock, text: string, image?: string) {
  if (block.type === 'code') return `<pre><code>${escapeHtml(text)}</code></pre>`;
  if (block.type === 'formula') return math(text, true);
  if (block.type === 'figure') return image ? `<img src="data:image/png;base64,${image}" alt="">` : '';
  if (block.type === 'table') return tableHtml(text);
  if (block.type === 'heading') { const level = Math.max(1, Math.min(6, block.level || 2)); return `<h${level}>${rich(text)}</h${level}>`; }
  return `<p>${rich(text)}</p>`;
}

const STYLE = `body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f1419;max-width:860px;margin:40px auto;padding:0 28px}
h1,h2,h3,h4{line-height:1.3;break-after:avoid;margin:28px 0 8px}h1{font-size:26px}h2{font-size:21px}h3{font-size:18px}h4{font-size:16px}
section{margin:0 0 18px}p{margin:0;orphans:3;widows:3;overflow-wrap:anywhere}
.translation{background:#f0f0f0;border-radius:10px;padding:10px 14px;margin-top:8px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.heading .translation{display:inline-block;padding:3px 10px;margin-top:4px}.heading .translation :is(h1,h2,h3,h4){margin:0;font-size:16px}
.list{display:flex;gap:10px;padding-left:8px}.list>.marker{min-width:1.4em;text-align:right}.list>div{flex:1;min-width:0}
.caption p,.reference p{font-size:14px}.footnote p{font-size:12px;color:#536471}
.figure{text-align:center;break-inside:avoid}.figure img{max-width:100%;height:auto}
math[display=block]{margin:8px 0;overflow-x:auto}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f9f9;padding:14px;border-radius:10px;font-size:13px}
table{border-collapse:collapse;width:100%;break-inside:avoid;font-size:14px}th,td{border:1px solid #cfd9de;padding:6px 8px;text-align:start;vertical-align:top;overflow-wrap:anywhere}thead{display:table-header-group}
.cell-translation{display:block;margin-top:3px;padding:1px 6px;border-radius:5px;background:#f0f0f0;font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.note{font-size:13px;color:#536471}@page{margin:16mm}@media print{body{max-width:none;margin:0;padding:0}a{color:inherit}}`;

export function exportDocument(record: DocumentRecord, language: string, format: string, mode: string, images: ReadonlyMap<string, string> = new Map()) {
  const translation = record.translations[language];
  const bilingual = mode !== 'translated';
  if (format === 'md') {
    return `# ${record.document.name}\n\n` + record.document.blocks.map(block => {
      const image = block.asset ? images.get(block.asset) : undefined;
      const render = (text: string) => block.type === 'heading' ? `${'#'.repeat(block.level || 2)} ${text}`
        : block.type === 'code' ? `\`\`\`\n${text}\n\`\`\`` : block.type === 'formula' ? `$$\n${text}\n$$`
        : block.type === 'figure' ? (image ? `![](data:image/png;base64,${image})` : '')
        : block.type === 'list' ? `${block.marker ?? '-'} ${text}` : text;
      if (!isTranslatable(block)) return render(block.text);
      const target = translation?.units[block.id];
      return bilingual ? `${render(block.text)}${target ? `\n\n${render(target)}` : '\n\n[Untranslated source]'}` : target !== undefined ? render(target) : `${render(block.text)}\n\n[Untranslated source]`;
    }).filter(Boolean).join('\n\n');
  }
  return `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(record.document.name)}</title><style>${STYLE}</style></head><body><p class="note">Open Immersive Translator · ${escapeHtml(language)} · ${bilingual ? 'Bilingual' : 'Translated'}</p>${record.document.blocks.map(block => {
    const target = translation?.units[block.id];
    let inner: string;
    if (!isTranslatable(block)) inner = blockHtml(block, block.text, block.asset ? images.get(block.asset) : undefined);
    else if (block.type === 'table' && target !== undefined) inner = bilingual ? tableHtml(block.text, target) : tableHtml(target);
    else if (bilingual && target?.trim() === block.text.trim()) inner = `<div class="source">${blockHtml(block, block.text)}</div>`;
    else inner = `${bilingual || target === undefined ? `<div class="source">${blockHtml(block, block.text)}</div>` : ''}${target !== undefined ? `<div class="translation" dir="auto">${blockHtml(block, target)}</div>` : '<p class="note">Untranslated source</p>'}`;
    if (block.type === 'list') inner = `<span class="marker">${escapeHtml(block.marker ?? '•')}</span><div>${inner}</div>`;
    return `<section class="${block.type}">${inner}</section>`;
  }).join('\n')}</body></html>`;
}
