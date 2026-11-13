/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { referenceIconFor } from './reference-icon';

const SRC = join(__dirname, '../../..');

function iconKind(node: ReturnType<typeof referenceIconFor>): string | null {
  const { container } = render(<>{node}</>);
  return (
    container.querySelector('[data-reference-icon]')?.getAttribute('data-reference-icon') ?? null
  );
}

describe('referenceIconFor', () => {
  it('gives a primer its registry glyph, not an emoji', () => {
    expect(iconKind(referenceIconFor('primer'))).toBe('primer');
  });

  it('gives a sequence the biology file glyph', () => {
    expect(iconKind(referenceIconFor('sequence'))).toBe('sequence');
  });

  it('treats page and page-link as the same kind', () => {
    expect(iconKind(referenceIconFor('page'))).toBe('notebook');
    expect(iconKind(referenceIconFor('page-link'))).toBe('notebook');
  });

  it('falls back rather than rendering nothing for an unknown kind', () => {
    expect(iconKind(referenceIconFor('something-new'))).toBe('unknown');
  });
});

describe('no surface keeps its own primer literal', () => {
  const SITES = [
    'features/page/embeds/primer/definition.ts',
    'features/page/editor/components/GenericEmbedRenderer.tsx',
    'features/page/editor/lib/search.ts',
  ];

  for (const site of SITES) {
    it(`${site} has no 🔬 literal`, () => {
      const source = readFileSync(join(SRC, site), 'utf8');
      expect(source).not.toContain('🔬');
    });
  }

  it('each of those sites routes through the shared helper', () => {
    for (const site of SITES) {
      const source = readFileSync(join(SRC, site), 'utf8');
      expect(source, `${site} should use referenceIconFor`).toContain('referenceIconFor');
    }
  });
});
