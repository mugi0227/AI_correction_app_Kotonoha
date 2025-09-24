import React, { useEffect, useRef, useState } from 'react';

export default function KebabMenu({ items = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('focusin', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('focusin', onDoc);
    };
  }, []);
  const onKey = (e) => {
    if (e.key === 'Escape') setOpen(false);
  };
  return (
    <div className="kebab" ref={ref} onKeyDown={onKey}>
      <button className="kebab-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)} title="操作">
        ⋮
      </button>
      {open && (
        <div className="kebab-menu" role="menu">
          {items.map((it, i) => (
            <button
              key={i}
              className={`kebab-item${it.danger ? ' danger' : ''}`}
              role="menuitem"
              disabled={!!it.disabled}
              onClick={() => { setOpen(false); try { it.onClick && it.onClick(); } catch {} }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
