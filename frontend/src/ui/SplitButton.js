import React, { useEffect, useRef, useState } from 'react';

export default function SplitButton({ label, appearance='secondary', onClick, items=[], iconBefore=null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('focusin', onDoc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('focusin', onDoc); };
  }, []);
  return (
    <div className="ds-split" ref={ref}>
      <button className={`ds-btn ds-btn--${appearance}`} onClick={onClick}>{iconBefore}{label}</button>
      <button className={`ds-btn ds-btn--${appearance}`} aria-haspopup="menu" aria-expanded={open} onClick={()=> setOpen(v=>!v)}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && (
        <div className="ds-menu" role="menu">
          {items.map((it, i) => (
            <button key={i} className={`ds-item${it.danger?' danger':''}`} role="menuitem" onClick={()=>{ setOpen(false); try { it.onClick && it.onClick(); } catch {} }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
