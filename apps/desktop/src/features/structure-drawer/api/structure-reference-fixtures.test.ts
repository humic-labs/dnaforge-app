// @vitest-environment node

import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdsToProtein, parseGenBankFull, type Annotation } from '@waypoint/sequence-utils';
import MG1655_MIOC_GB from '../../../../../../test-fixtures/sequences/linear/structure-mg1655-mioc-ape-label.gb?raw';
import S288C_SEO1_GB from '../../../../../../test-fixtures/sequences/linear/structure-s288c-seo1-ape-label.gb?raw';
import { extractHintsFromAnnotation } from './extract-hints';
import { proteinSequenceStep } from './steps/protein-sequence';
import { sidecarAfdbHit } from './__tests__/sidecar-mocks';
import './__tests__/sidecar-mocks';

const ABORT = new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
});

function bySequenceHit(accession: string, protein: string, md5: string) {
  return new Response(
    JSON.stringify({
      md5,
      query_identity: {
        kind: 'protein_sequence',
        normalized_length: protein.length,
        checksum_md5: md5,
        checksum_sha256: sha256(protein),
        canonical_form: 'waypoint-protein-v2',
        canonical_lookup_sequence: protein,
        canonical_form_applied: true,
        ineligible: false,
        evidence: [],
      },
      hits: [
        {
          accession,
          reviewed: true,
          pdb_ids: [],
          pdb_xrefs: [],
          match_evidence: {
            kind: 'exact_sequence_checksum',
            checksum_md5: md5,
            sequence_identity: 1,
            rank: 0,
            rank_reasons: ['checksum_match', 'reviewed'],
          },
        },
      ],
    }),
    { status: 200 }
  );
}

function firstCds(genbank: string): Annotation {
  const parsed = parseGenBankFull(genbank);
  const cds = parsed.annotations.find((annotation) => annotation.type === 'CDS');
  if (!cds) throw new Error('fixture must contain a CDS');
  return cds;
}

function fixtureProtein(genbank: string): string {
  const parsed = parseGenBankFull(genbank);
  const cds = firstCds(genbank);
  const direction = cds.direction === -1 ? -1 : 1;
  const protein = cdsToProtein(
    cds.start,
    cds.end,
    direction,
    parsed.sequence,
    parsed.circular ? parsed.length : undefined
  );
  if (!protein) throw new Error(`fixture CDS did not translate: ${cds.name}`);
  return protein;
}

function md5(protein: string): string {
  return createHash('md5').update(protein).digest('hex').toUpperCase();
}

function sha256(protein: string): string {
  return createHash('sha256').update(protein).digest('hex');
}

const FIXTURES = [
  {
    label: 'MG1655 mioC',
    genbank: MG1655_MIOC_GB,
    geneName: 'mioC',
    accession: 'P03817',
    md5: '4BFC2ED15C60BB6BF4D68FC54F668B53',
  },
  {
    label: 'S288C SEO1',
    genbank: S288C_SEO1_GB,
    geneName: 'SEO1',
    accession: 'P39709',
    md5: 'DAC740BAAB1FB48DF0782EF4A476B633',
  },
] as const;

describe('structure drawer public reference fixtures', () => {
  it.each(FIXTURES)(
    '$label fixture is label-only and still yields the canonical protein bytes',
    ({ genbank, geneName, md5: expectedMd5 }) => {
      const cds = firstCds(genbank);
      const protein = fixtureProtein(genbank);

      expect(cds.qualifiers?.translation).toBeUndefined();
      expect(cds.qualifiers?.db_xref).toBeUndefined();
      expect(extractHintsFromAnnotation(cds).geneName).toBe(geneName);
      expect(protein).not.toContain('*');
      expect(md5(protein)).toBe(expectedMd5);
    }
  );

  it.each(FIXTURES)(
    '$label resolves through exact protein sequence without CDS xrefs or /translation',
    async ({ genbank, accession, md5: expectedMd5 }) => {
      const protein = fixtureProtein(genbank);
      const cds = firstCds(genbank);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(bySequenceHit(accession, protein, expectedMd5))
        .mockResolvedValueOnce(sidecarAfdbHit(accession, 87.5));

      const result = await proteinSequenceStep.resolve(
        protein,
        extractHintsFromAnnotation(cds),
        ABORT
      );

      expect(result).not.toBeNull();
      expect(result?.source).toBe('protein_sequence');
      expect(result?.structure).toMatchObject({ kind: 'uniprot', accession });
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? '{}'));
      expect(body.sequence).toBe(protein);
    }
  );
});
