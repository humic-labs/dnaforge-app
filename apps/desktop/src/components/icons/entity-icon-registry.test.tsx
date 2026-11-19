import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTabIcon } from '../../features/canvas/components/Tab';
import { referenceIconFor } from '../../features/page/entity-ref/reference-icon';
import { OligoIcon, StructureFileIcon } from './glyphs';
import { PrimerIcon } from './stateful';
import {
  ENTITY_ICON_KINDS,
  canonicalEntityIconKind,
  entityIconKindForCatalogPresentation,
  entityIconKindForWorkspaceTarget,
  iconForEntityKind,
} from './entity-icon-registry';

function glyphSignature(node: React.ReactNode): string {
  const { container } = render(<>{node}</>);
  const svg = container.querySelector('svg');
  if (!svg) return `NO-SVG:${container.textContent ?? ''}`;
  return [...svg.querySelectorAll('path, rect, circle, line, polyline, polygon')]
    .map((el) => el.getAttribute('d') ?? el.outerHTML.replace(/class="[^"]*"/, ''))
    .join('|');
}

describe('entity icon registry', () => {
  it('uses the DNA color for genome entities', () => {
    const { container } = render(<>{iconForEntityKind('genome')}</>);
    expect(container.querySelector('[data-icon="genome-assembly"]')).toHaveAttribute(
      'data-entity-color-family',
      'dna'
    );
  });

  it('resolves a glyph for every declared kind', () => {
    for (const kind of ENTITY_ICON_KINDS) {
      expect(iconForEntityKind(kind), `no glyph for ${kind}`).not.toBeNull();
    }
  });

  it('maps each surface’s own vocabulary onto the same canonical kind', () => {
    expect(canonicalEntityIconKind('page')).toBe('notebook');
    expect(canonicalEntityIconKind('page-link')).toBe('notebook');
    expect(canonicalEntityIconKind('notebook')).toBe('notebook');
    expect(canonicalEntityIconKind('plasmid')).toBe('sequence');
    expect(canonicalEntityIconKind('sequence_region')).toBe('annotation');
    expect(canonicalEntityIconKind('annotation')).toBe('annotation');
    expect(canonicalEntityIconKind('alignment')).toBe('alignment');
    expect(canonicalEntityIconKind('oligo')).toBe('primer');
    expect(canonicalEntityIconKind('dna-sequences')).toBe('sequence');
    expect(canonicalEntityIconKind('primers')).toBe('primer');
    expect(canonicalEntityIconKind('strains')).toBe('strain');
    expect(canonicalEntityIconKind('proteins')).toBe('protein');
    expect(canonicalEntityIconKind('folder')).toBe('folder');
    expect(canonicalEntityIconKind('workspace')).toBe('folder');
  });

  it('returns null for an unknown kind instead of a placeholder', () => {
    expect(iconForEntityKind('not-a-kind')).toBeNull();
    expect(canonicalEntityIconKind('not-a-kind')).toBeNull();
  });

  it('keeps custom records distinct from strain classification', () => {
    expect(entityIconKindForCatalogPresentation('record')).toBe('record');
    expect(glyphSignature(iconForEntityKind('record'))).not.toBe(
      glyphSignature(iconForEntityKind('strain'))
    );
  });

  it('uses the pre-existing approved structure glyph for protein entities', () => {
    expect(glyphSignature(<StructureFileIcon />)).not.toMatch(/^NO-SVG:/);
    expect(glyphSignature(iconForEntityKind('protein'))).toBe(
      glyphSignature(<StructureFileIcon />)
    );
  });

  it('keeps the pre-existing Registry oligo glyph for primer entities', () => {
    const primer = glyphSignature(iconForEntityKind('primer'));
    expect(primer).toBe(glyphSignature(<OligoIcon />));
    expect(primer).not.toBe(glyphSignature(<PrimerIcon />));
  });

  it('prevents the Add picker and Registry presenter from choosing entity glyphs privately', () => {
    const surfaces = [
      resolve(process.cwd(), 'src/components/ExplorerAddPicker.tsx'),
      resolve(process.cwd(), 'src/features/lims/components/registry-presenters.tsx'),
    ];
    const privateEntityGlyph =
      /\b(?:BiologyFileIcon|GenomeAssemblyIcon|OligoIcon|PrimerIcon|ProteinIcon|StrainIcon)\b/;

    for (const surface of surfaces) {
      const source = readFileSync(surface, 'utf8');
      expect(source, `${surface} must resolve kinds through the entity icon registry`).toContain(
        'iconForEntityKind'
      );
      expect(
        source,
        `${surface} imports or selects an entity glyph outside the registry`
      ).not.toMatch(privateEntityGlyph);
    }
  });

  it('classifies workspace targets with the existing file and package vocabulary', () => {
    expect(entityIconKindForWorkspaceTarget('pUC19', 'sequence-package')).toBe('sequence');
    expect(entityIconKindForWorkspaceTarget('constructs', 'directory')).toBe('folder');
    expect(entityIconKindForWorkspaceTarget('pUC19.gb', 'file')).toBe('sequence');
    expect(entityIconKindForWorkspaceTarget('1FS0.cif', 'file')).toBe('structure');
    expect(entityIconKindForWorkspaceTarget('notes.md', 'file')).toBe('text');
  });

  it('uses presentation kind, not catalog storage kind, for native rows', () => {
    expect(entityIconKindForCatalogPresentation('strain')).toBe('strain');
    expect(entityIconKindForCatalogPresentation('sequence')).toBe('sequence');
  });
});

describe('🟥 surfaces agree on the glyph for a kind', () => {
  it('a NOTEBOOK looks the same as a tab and as a reference chip', () => {
    const tab = glyphSignature(getTabIcon('page'));
    const chip = glyphSignature(referenceIconFor('page'));
    expect(tab).not.toMatch(/^NO-SVG/);
    expect(chip, 'the reference chip draws a different notebook glyph than the tab').toBe(tab);
  });

  it('a notebook chip is NOT an emoji', () => {
    const { container } = render(<>{referenceIconFor('page')}</>);
    expect(
      container.querySelector('svg'),
      'the chip is still rendering a text glyph'
    ).not.toBeNull();
    expect(container.textContent ?? '').not.toContain('📄');
  });

  it('a SEQUENCE looks the same as a tab and as a reference chip', () => {
    expect(glyphSignature(referenceIconFor('sequence'))).not.toMatch(/^NO-SVG:/);
    expect(glyphSignature(referenceIconFor('sequence'))).toBe(
      glyphSignature(getTabIcon('sequence'))
    );
  });

  it('a DESIGN looks the same as a tab and as a reference chip', () => {
    expect(glyphSignature(referenceIconFor('design'))).not.toMatch(/^NO-SVG:/);
    expect(glyphSignature(referenceIconFor('design'))).toBe(glyphSignature(getTabIcon('design')));
  });

  it('every registry kind the canvas also knows renders identically on both', () => {
    const canvasKinds = ['page', 'sequence', 'design', 'chat', 'structure', 'protein'];
    const disagreements: string[] = [];
    let compared = 0;
    for (const kind of canvasKinds) {
      const fromRegistry = iconForEntityKind(kind);
      if (!fromRegistry) continue;
      compared++;
      const viaTab = glyphSignature(getTabIcon(kind as Parameters<typeof getTabIcon>[0]));
      const viaRegistry = glyphSignature(fromRegistry);
      if (viaTab !== viaRegistry) disagreements.push(kind);
    }
    expect(compared).toBeGreaterThan(0);
    expect(disagreements, `surfaces disagree on: ${disagreements.join(', ')}`).toEqual([]);
  });
});
