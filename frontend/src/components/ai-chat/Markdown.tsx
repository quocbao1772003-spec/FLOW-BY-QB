import { Fragment, type ReactNode } from "react";

/**
 * Small, dependency-free Markdown renderer for chat replies: paragraphs,
 * headings, bullet / numbered lists, block quotes, fenced code, inline
 * code, bold and italic. Everything is rendered as React nodes — no HTML
 * injection — so model output can't smuggle markup into the page.
 */

export interface CodeBlockProps {
  code: string;
  lang: string;
  index: number;
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // `code` | **bold** | *italic* / _italic_
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[], keyBase: string): ReactNode[] {
  return lines.flatMap((l, i) => (i === 0 ? inline(l, `${keyBase}-${i}`) : [<br key={`${keyBase}-br${i}`} />, ...inline(l, `${keyBase}-${i}`)]));
}

function blocks(text: string, keyBase: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const k = `${keyBase}-b${n++}`;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const Tag = (h[1].length <= 2 ? "h3" : "h4") as "h3" | "h4";
      out.push(<Tag key={k}>{inline(h[2], k)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      out.push(
        <ul key={k}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push(
        <ol key={k}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={k}>{withBreaks(q, k)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(<p key={k}>{withBreaks(para, k)}</p>);
  }
  return out;
}

/** Split out ``` fences; an unclosed fence (still streaming) renders as code too. */
export function splitFences(src: string): Array<{ kind: "text"; text: string } | { kind: "code"; code: string; lang: string }> {
  const parts: Array<{ kind: "text"; text: string } | { kind: "code"; code: string; lang: string }> = [];
  const re = /```([^\n`]*)\n?([\s\S]*?)(```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push({ kind: "text", text: src.slice(last, m.index) });
    parts.push({ kind: "code", lang: m[1].trim(), code: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
    if (m[0].length === 0) break;
  }
  if (last < src.length) parts.push({ kind: "text", text: src.slice(last) });
  return parts;
}

export function Markdown({
  text,
  renderCode,
}: {
  text: string;
  renderCode: (p: CodeBlockProps) => ReactNode;
}) {
  let codeIdx = 0;
  return (
    <>
      {splitFences(text).map((part, i) =>
        part.kind === "text" ? (
          <Fragment key={i}>{blocks(part.text, `t${i}`)}</Fragment>
        ) : (
          <Fragment key={i}>{renderCode({ code: part.code, lang: part.lang, index: codeIdx++ })}</Fragment>
        ),
      )}
    </>
  );
}
