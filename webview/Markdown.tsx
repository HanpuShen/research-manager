import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import type { SourceRef } from '../src/types.js';

type OpenSource = (command: string, payload?: any) => void;
export function markdownSource(href: string, documentPath?: string): SourceRef | undefined {
  if (/^https?:\/\//i.test(href)) return { url: href };
  if (!href || href.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('file:')) return;
  try {
    const url = href.startsWith('file:') ? new URL(href) : new URL(href, `file://${documentPath || '/'}`);
    return { path: decodeURIComponent(url.pathname), ...(url.hash.match(/^#L?(\d+)$/) ? { line: Number(url.hash.match(/^#L?(\d+)$/)![1]) } : {}) };
  } catch { return; }
}

export function PreviewImage({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    close.current?.focus();
    return () => trigger.current?.focus({ preventScroll: true });
  }, [expanded]);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) return <span className="preview-image-error" role="status">Image could not be displayed: {alt}</span>;
  return <span className="preview-image">
    <button ref={trigger} className="preview-image-button" type="button" aria-label={`Enlarge figure: ${alt}`} onClick={() => setExpanded(true)}><img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} /></button>
    {caption && <span className="preview-caption">{caption}</span>}
    {expanded && createPortal(<div className="figure-backdrop" onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <section className="figure-dialog" role="dialog" aria-modal="true" aria-label={`Figure: ${alt}`} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); }
        if (event.key === 'Tab') { event.preventDefault(); close.current?.focus(); }
      }}>
        <div className="figure-heading"><span>{alt}</span><button ref={close} className="icon-button" aria-label="Close figure" onClick={() => setExpanded(false)}>×</button></div>
        <div className="figure-scroll"><img src={src} alt={alt} /></div>{caption && <p className="preview-caption">{caption}</p>}
      </section>
    </div>, document.body)}
  </span>;
}

export function MarkdownText({ text, images = {}, documentPath, send }: { text: string; images?: Record<string, string>; documentPath?: string; send?: OpenSource }) {
  return <div className="markdown-text"><ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, maxExpand: 1000, maxSize: 20 }]]} skipHtml urlTransform={url => {
    if (Object.hasOwn(images, url)) return url;
    return markdownSource(url, documentPath) ? url : '';
  }} components={{
    h1: ({ children }) => <h4>{children}</h4>, h2: ({ children }) => <h4>{children}</h4>, h3: ({ children }) => <h4>{children}</h4>,
    a: ({ href, children }) => {
      const source = href ? markdownSource(href, documentPath) : undefined;
      return source ? <a href={source.url || '#'} onClick={event => { if (send || source.path) { event.preventDefault(); send?.('openSource', { source }); } }} {...(!send && source.url ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>{children}</a> : <span>{children}</span>;
    },
    img: ({ src, alt }) => {
      const dataUrl = typeof src === 'string' && Object.hasOwn(images, src) ? images[src] : '';
      return /^data:image\/(png|jpeg|gif|webp);base64,/i.test(dataUrl) ? <PreviewImage src={dataUrl} alt={alt || 'Figure'} /> : <span className="preview-image-error">{alt || 'Figure'} · Image preview unavailable</span>;
    },
    table: ({ children }) => <div className="preview-table-scroll" tabIndex={0} role="region" aria-label="Markdown table"><table>{children}</table></div>,
    th: ({ node, ...props }) => <th {...props} scope="col" />,
  }}>{text}</ReactMarkdown></div>;
}

/** One line of text with $…$ rendered by KaTeX (titles, banners, map cards); everything else stays plain text. */
export function InlineMath({ text }: { text: string }) {
  const parts = String(text ?? '').split(/(\$[^$\n]+\$)/g);
  return <>{parts.map((part, i) => /^\$[^$\n]+\$$/.test(part)
    ? <span key={i} className="inline-math" dangerouslySetInnerHTML={{ __html: katex.renderToString(part.slice(1, -1), { throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20 }) }} />
    : <React.Fragment key={i}>{part}</React.Fragment>)}</>;
}
