import { createElement, type ReactNode } from 'react';
import { FileTypeIcon } from '../../../components/icons/file-type-icon';
import type { EntityColorContext } from '../../../shared/entity-color-family';

import {
  canonicalEntityIconKind,
  iconForEntityKind,
} from '../../../components/icons/entity-icon-registry';

export type ReferenceIconKind = 'page' | 'sequence' | 'primer' | 'design' | 'structure3d';

function marked(kind: string, child: ReactNode): ReactNode {
  return createElement('span', { 'data-reference-icon': kind, className: 'inline-flex' }, child);
}

export function referenceIconFor(
  kind: string,
  className = 'w-4 h-4',
  context?: EntityColorContext
): ReactNode {
  const canonical = canonicalEntityIconKind(kind);
  const glyph = iconForEntityKind(kind, className, context);
  if (glyph && canonical) return marked(canonical, glyph);

  switch (kind) {
    case 'image':
      return marked(
        'image',
        createElement(FileTypeIcon, { category: 'image', className, context })
      );
    case 'table':
      return marked(
        'table',
        createElement(FileTypeIcon, { category: 'spreadsheet', className, context })
      );
    default:
      return marked(
        'unknown',
        createElement(FileTypeIcon, {
          category: 'generic',
          className,
          context: { kind, ...context },
        })
      );
  }
}
