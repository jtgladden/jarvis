"use client";

import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders journal/scripture markdown with the app's dark styling.
 *
 * Journal entries are stored as markdown (transcribed by the vision model or
 * hand-edited). This is the single render surface so paragraph breaks, lists,
 * emphasis, and blockquotes all reproduce the original page formatting.
 *
 * `highlightText` optionally post-processes plain text nodes — used to preserve
 * the search/study-link reference highlighting from the journal view. It is
 * applied to the direct string children of common block/inline elements, which
 * covers the ordinary case (matched terms sitting in paragraph/list/quote text).
 */

type HighlightFn = (text: string) => React.ReactNode;

function renderChildren(children: React.ReactNode, highlight?: HighlightFn): React.ReactNode {
  if (!highlight) return children;
  return React.Children.map(children, (child) =>
    typeof child === "string" ? highlight(child) : child
  );
}

function buildComponents(highlight?: HighlightFn): Components {
  const h = (children: React.ReactNode) => renderChildren(children, highlight);
  return {
    p: ({ children }) => <p className="mb-3 last:mb-0 break-words">{h(children)}</p>,
    ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
    ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
    li: ({ children }) => <li className="break-words">{h(children)}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-violet-300/40 pl-3 italic text-slate-300">
        {children}
      </blockquote>
    ),
    h1: ({ children }) => <h1 className="mb-2 mt-1 text-base font-semibold text-slate-50">{h(children)}</h1>,
    h2: ({ children }) => <h2 className="mb-2 mt-1 text-sm font-semibold text-slate-50">{h(children)}</h2>,
    h3: ({ children }) => <h3 className="mb-2 mt-1 text-sm font-semibold text-slate-100">{h(children)}</h3>,
    strong: ({ children }) => <strong className="font-semibold text-slate-50">{h(children)}</strong>,
    em: ({ children }) => <em className="italic">{h(children)}</em>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-violet-300 underline underline-offset-2 hover:text-violet-200">
        {children}
      </a>
    ),
    code: ({ children }) => (
      <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em] text-slate-100">{children}</code>
    ),
    hr: () => <hr className="my-4 border-white/10" />,
  };
}

export function MarkdownContent({
  children,
  className,
  highlightText,
}: {
  children: string | null | undefined;
  className?: string;
  highlightText?: HighlightFn;
}) {
  const value = children || "";
  return (
    <div className={`text-sm leading-6 text-slate-100 ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={buildComponents(highlightText)}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownContent;
