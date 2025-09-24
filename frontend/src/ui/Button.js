import React from 'react';

export default function Button({ appearance='subtle', size='m', iconBefore, iconAfter, children, className='', ...rest }) {
  const cls = [
    'ds-btn',
    appearance ? `ds-btn--${appearance}` : '',
    size === 's' ? 'ds-btn--s' : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest}>
      {iconBefore}
      <span>{children}</span>
      {iconAfter}
    </button>
  );
}

export function IconButton({ appearance='subtle', size='s', children, className='', ...rest }) {
  const cls = [
    'ds-btn',
    'ds-btn--icon',
    appearance ? `ds-btn--${appearance}` : '',
    size === 's' ? 'ds-btn--s' : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
