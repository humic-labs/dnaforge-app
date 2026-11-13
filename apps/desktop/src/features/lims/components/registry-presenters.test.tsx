/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { iconForEntityKind } from '../../../components/icons';
import { registrationStatusLabel } from '../../../shared/lims';
import {
  StatusPill,
  iconForLimsKind,
  registryTypeLabel,
  singularKindLabel,
} from './registry-presenters';

describe('iconForLimsKind', () => {
  it('delegates every known LIMS kind to the app-wide entity icon registry', () => {
    for (const kind of [
      'oligo',
      'rna_oligo',
      'plasmid',
      'chromosome',
      'genome',
      'strain',
      'protein',
      'track-view',
    ]) {
      expect(iconForLimsKind(kind)?.type).toBeTruthy();
      expect(iconForLimsKind(kind)?.type).toBe(iconForEntityKind(kind)?.type);
    }
  });

  it('has no icon for DNA and RNA sequence kinds yet ', () => {
    expect(iconForLimsKind('dna_sequence')).toBeNull();
    expect(iconForLimsKind('rna_sequence')).toBeNull();
  });

  it('renders no icon for an unknown/user-defined kind', () => {
    expect(iconForLimsKind('organism')).toBeNull();
    expect(iconForLimsKind('some-custom-kind')).toBeNull();
  });
});

describe('singularKindLabel', () => {
  it('labels every LIMS entity kind, mapping genome to "assembly"', () => {
    expect(singularKindLabel('oligo')).toBe('DNA oligo');
    expect(singularKindLabel('rna_oligo')).toBe('RNA oligo');
    expect(singularKindLabel('plasmid')).toBe('plasmid');
    expect(singularKindLabel('genome')).toBe('assembly');
    expect(singularKindLabel('chromosome')).toBe('chromosome');
    expect(singularKindLabel('strain')).toBe('strain');
    expect(singularKindLabel('organism')).toBe('organism');
    expect(singularKindLabel('protein')).toBe('protein');
    expect(singularKindLabel('dna_sequence')).toBe('DNA sequence');
    expect(singularKindLabel('rna_sequence')).toBe('RNA sequence');
    expect(singularKindLabel('track-view')).toBe('track view');
    expect(registryTypeLabel('track-view')).toBe('track view');
  });

  it('labels the  Phase 4 promoted kinds', () => {
    expect(singularKindLabel('guide_rna')).toBe('guide RNA');
    expect(singularKindLabel('allele')).toBe('allele');
    expect(singularKindLabel('locus')).toBe('locus');
    expect(singularKindLabel('part')).toBe('part');
    expect(singularKindLabel('fragment')).toBe('fragment');
    expect(singularKindLabel('marker')).toBe('marker');
    expect(singularKindLabel('external_ref')).toBe('external reference');
    expect(singularKindLabel('custom_protein_schema')).toBe('custom_protein_schema');
  });
});

describe('StatusPill registration-status flag (M2)', () => {
  it('renders an unresolved entity as a WARNING, distinct from a registered one', () => {
    render(
      <>
        <StatusPill status="unresolved">{registrationStatusLabel('unresolved')}</StatusPill>
        <StatusPill status="registered">{registrationStatusLabel('registered')}</StatusPill>
      </>
    );

    const pills = screen.getAllByText(/unresolved|registered/i);
    const unresolved = pills.find((el) => el.dataset.registrationStatus === 'unresolved');
    const registered = pills.find((el) => el.dataset.registrationStatus === 'registered');
    expect(unresolved).toBeTruthy();
    expect(registered).toBeTruthy();

    expect(unresolved!.className).toContain('text-warning');
    expect(registered!.className).not.toContain('text-warning');
    expect(registered!.className).toContain('text-fg-subtle');
  });

  it('exposes the status as a data attribute for downstream assertions', () => {
    render(<StatusPill status="unresolved">UNRESOLVED</StatusPill>);
    expect(screen.getByText('UNRESOLVED').dataset.registrationStatus).toBe('unresolved');
  });
});
