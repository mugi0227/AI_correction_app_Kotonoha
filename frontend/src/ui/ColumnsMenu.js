import React, { useEffect, useRef, useState } from 'react';

export default function ColumnsMenu({ value, onChange, lockedKeys = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('focusin', onDoc);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('focusin', onDoc); };
  }, []);
  const toggle = (k) => {
    const next = { ...value, [k]: !value[k] };
    if (lockedKeys.includes(k)) return; // safety
    onChange && onChange(next);
  };
  return (
    <div className="kebab" ref={ref}>
      <button className="kebab-btn" onClick={() => setOpen(v=>!v)} aria-haspopup="menu" aria-expanded={open}>列</button>
      {open && (
        <div className="kebab-menu" role="menu" style={{ padding: 6 }}>
          {Object.keys(value).map((k) => (
            <label key={k} className="kebab-item" style={{ display:'flex', gap:8, alignItems:'center' }}>
              <input type="checkbox" checked={!!value[k]} disabled={lockedKeys.includes(k)} onChange={()=>toggle(k)} />
              <span>
                {k === 'uploaded_at' && 'アップロード日'}
                {k === 'editing_time' && '編集時間'}
                {k === 'exam' && '試験種'}
                {k === 'status' && 'ステータス'}
                {k === 'quality' && '仕分け理由'}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
