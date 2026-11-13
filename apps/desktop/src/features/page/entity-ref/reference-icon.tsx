import { createElement, type ReactNode } from 'react';

import {
  canonicalEntityIconKind,
  iconForEntityKind,
} from '../../../components/icons/entity-icon-registry';

export type ReferenceIconKind = 'page' | 'sequence' | 'primer' | 'design' | 'structure3d';

function marked(kind: string, child: ReactNode): ReactNode {
  return createElement('span', { 'data-reference-icon': kind, className: 'inline-flex' }, child);
}

export function referenceIconFor(kind: string, className = 'w-4 h-4'): ReactNode {
  const canonical = canonicalEntityIconKind(kind);
  const glyph = iconForEntityKind(kind, className);
  if (glyph && canonical) return marked(canonical, glyph);

  switch (kind) {
    case 'image':
      return createElement('span', { 'data-reference-icon': 'image' }, '🖼');
    case 'table':
      return createElement('span', { 'data-reference-icon': 'table' }, '⊞');
    default:
      return createElement('span', { 'data-reference-icon': 'unknown' }, '📎');
  }
}
