import React, { useEffect, useMemo, useRef } from 'react';

// Renders Markdown -> HTML using window.marked and window.DOMPurify from CDN,
// then renders TeX via KaTeX auto-render.
export default function MarkdownPreview({ markdown = '', className = '' }) {
  const containerRef = useRef(null);

  const html = useMemo(() => {
    try {
      const m = window.marked?.parse ? window.marked.parse(markdown, { gfm: true, breaks: true }) : markdown;
      const clean = window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(m, { USE_PROFILES: { html: true } }) : m;
      return clean;
    } catch (e) {
      return markdown;
    }
  }, [markdown]);

  useEffect(() => {
    // Render math after HTML is updated
    if (containerRef.current && typeof window.renderMathInElement === 'function') {
      try {
        window.renderMathInElement(containerRef.current, {
          // Support both inline $...$ and display $$...$$
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch {}
    }
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={`md-preview ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

