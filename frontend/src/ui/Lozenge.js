import React from 'react';

export default function Lozenge({ variant = 'default', children }) {
  const cls = `lozenge lozenge--${variant}`;
  return <span className={cls}>{children}</span>;
}

export function statusToVariant(status) {
  const s = String(status || '').trim();
  if (!s) return 'default';
  if (s.includes('エラー')) return 'error';
  if (s === '添削完了') return 'success';
  if (s === '要レビュー' || s === 'AI添削完了') return 'warning';
  if (s.includes('処理中') || s.includes('再処理中')) return 'inprogress';
  if (s.startsWith('仕分済')) return 'default';
  return 'default';
}
