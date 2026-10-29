import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { splitMath } from '@oit/core/document';

// KaTeX escapes its input and runs without `trust`, so its markup is safe to mount.
const render = (latex: string, displayMode: boolean) => katex.renderToString(latex, { displayMode, throwOnError: false, output: 'htmlAndMathml' });

/** Prose with `$…$` / `$$…$$` formulas rendered in place. */
export function RichText({ text }: { text: string }) {
  const parts = useMemo(() => splitMath(text), [text]);
  if (parts.length === 1 && parts[0]!.kind === 'text') return <>{text}</>;
  return <>{parts.map((part, index) => part.kind === 'text' ? part.value
    : <span key={index} className={part.display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: render(part.value, part.display) }} />)}</>;
}

export function MathBlock({ latex }: { latex: string }) {
  const html = useMemo(() => render(latex, true), [latex]);
  return <div className="math-display" dangerouslySetInnerHTML={{ __html: html }} />;
}
