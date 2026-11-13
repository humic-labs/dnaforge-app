import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StructureVariantContext } from './StructureVariantContext';
import {
  useStructureLinkRegistry,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import type { StructureDrawerRequest } from '../types/structure-drawer';

const request: StructureDrawerRequest = {
  translation: 'MKG',
  cdsLabel: 'Reporter',
  entityId: 'seq:reference',
  hints: {},
  variantContext: {
    trackId: 'clone-7',
    trackLabel: 'Clone 7',
    mutationId: 'change',
    position: 6,
    referenceBase: 'AG',
    alternateBase: 'TC',
    residueIndices: [1, 2],
  },
};
const link: StructureLinkEntry = {
  structureId: 'structure',
  ownerId: 'owner',
  sequenceDocumentId: 'seq:reference',
  translation: 'MKG',
  cdsLabel: 'Reporter',
  cdsStart: 0,
  cdsEnd: 8,
  strand: 1,
  residueTargets: [{ chain: 'B', residues: [{ residueIndex: 1, position: 402 }] }],
};
beforeEach(() => useStructureLinkRegistry.setState({ links: {} }));

describe('variant structural context', () => {
  it('counts mapped protein positions, preserves missing positions and labels unmodeled alternates', () => {
    useStructureLinkRegistry.getState().registerLink(link);
    render(
      <StructureVariantContext request={request} structureId="structure" ownerId="owner" ready />
    );
    expect(screen.getByTestId('structure-variant-context')).toHaveTextContent(
      'Reporter residues 2, 3'
    );
    expect(screen.getByTestId('structure-variant-context')).toHaveTextContent(
      'Alternate side chains have not been modeled.'
    );
    expect(screen.getByTestId('structure-variant-mapping-status')).toHaveTextContent('1 of 2');
  });

  it('does not borrow coordinates from another document or owner', () => {
    useStructureLinkRegistry.getState().registerLink({ ...link, ownerId: 'another-owner' });
    render(
      <StructureVariantContext request={request} structureId="structure" ownerId="owner" ready />
    );
    expect(screen.getByTestId('structure-variant-mapping-status')).toHaveTextContent('0 of 2');
  });
});
