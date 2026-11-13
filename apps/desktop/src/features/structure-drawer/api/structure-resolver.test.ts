// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import type {
  ResolverStep,
  ResolverResult,
  ResolveHints,
  StructureDrawerRequest,
} from '../types/structure-drawer';
import {
  resolveStructure,
  resolveStructureRequest,
  BUILTIN_STEPS,
  NON_PROTEIN_STEPS,
  defaultResolverStepsForRequest,
} from './structure-resolver';

function fakeStep(
  name: ResolverStep['name'],
  priority: number,
  result: ResolverResult | null,
  options: { hintsRequired?: (keyof ResolveHints)[]; throws?: Error } = {}
): ResolverStep {
  return {
    name,
    priority,
    hintsRequired: options.hintsRequired ?? ['dbXrefs'],
    resolve: vi.fn(async () => {
      if (options.throws) throw options.throws;
      return result;
    }),
  };
}

describe('resolveStructure', () => {
  it('returns null when there are no applicable steps', async () => {
    const out = await resolveStructure('M', {}, new AbortController().signal, {
      steps: [fakeStep('pdb_xref', 10, null, { hintsRequired: ['dbXrefs'] })],
    });
    expect(out).toBeNull();
  });

  it('runs steps in priority order', async () => {
    const calls: string[] = [];
    const wrap = (name: ResolverStep['name'], priority: number, result: ResolverResult | null) =>
      ({
        name,
        priority,
        hintsRequired: [],
        resolve: vi.fn(async () => {
          calls.push(name);
          return result;
        }),
      }) as ResolverStep;

    await resolveStructure('M', {}, new AbortController().signal, {
      steps: [
        wrap('gene_organism', 70, null),
        wrap('pdb_xref', 10, null),
        wrap('uniprot_xref', 20, null),
      ],
    });

    expect(calls).toEqual(['pdb_xref', 'uniprot_xref', 'gene_organism']);
  });

  it('short-circuits on the first hit', async () => {
    const second = vi.fn(async () => null);
    const out = await resolveStructure(
      'M',
      { dbXrefs: ['PDB:1TUP'] },
      new AbortController().signal,
      {
        steps: [
          fakeStep('pdb_xref', 10, {
            source: 'pdb_xref',
            identity: 1,
            structure: { kind: 'pdb', pdbId: '1TUP' },
          }),
          { name: 'uniprot_xref', priority: 20, hintsRequired: [], resolve: second },
        ],
      }
    );
    expect(out?.source).toBe('pdb_xref');
    expect(second).not.toHaveBeenCalled();
  });

  it('skips steps whose hintsRequired are missing', async () => {
    const skipped = vi.fn(async () => null);
    await resolveStructure('M', { dbXrefs: ['PDB:1TUP'] }, new AbortController().signal, {
      steps: [
        {
          name: 'locus_tag',
          priority: 60,
          hintsRequired: ['locusTag', 'taxonId'],
          resolve: skipped,
        },
      ],
    });
    expect(skipped).not.toHaveBeenCalled();
  });

  it('honors per-request skipSteps', async () => {
    const pdbStep = fakeStep('pdb_xref', 10, {
      source: 'pdb_xref',
      identity: 1,
      structure: { kind: 'pdb', pdbId: '1TUP' },
    });
    const uniprotStep = fakeStep('uniprot_xref', 20, {
      source: 'uniprot_xref',
      identity: 1,
      structure: { kind: 'uniprot', accession: 'P00001' },
    });
    const out = await resolveStructure(
      'M',
      { dbXrefs: ['PDB:1TUP', 'UniProtKB:P00001'] },
      new AbortController().signal,
      {
        steps: [pdbStep, uniprotStep],
        skipSteps: ['pdb_xref'],
      }
    );
    expect(out?.source).toBe('uniprot_xref');
    expect(pdbStep.resolve).not.toHaveBeenCalled();
  });

  it('passes the full StructureDrawerRequest into resolver steps', async () => {
    const request: StructureDrawerRequest = {
      translation: 'M',
      hints: { dbXrefs: ['UniProtKB:P00880'] },
      identityRequestKey: 'req:feature:v2:test:protein-sequence:v2:test',
    };
    const step = fakeStep('protein_sequence', 5, {
      source: 'protein_sequence',
      identity: 1,
      structure: { kind: 'uniprot', accession: 'P00880' },
    });

    await resolveStructureRequest(request, new AbortController().signal, {
      steps: [step],
    });

    expect(step.resolve).toHaveBeenCalledWith('M', request.hints, expect.any(AbortSignal), request);
  });

  it('falls through soft errors from individual steps', async () => {
    const out = await resolveStructure(
      'M',
      { dbXrefs: ['PDB:1TUP'] },
      new AbortController().signal,
      {
        steps: [
          fakeStep('pdb_xref', 10, null, { throws: new Error('network blip') }),
          fakeStep('uniprot_xref', 20, {
            source: 'uniprot_xref',
            identity: 1,
            structure: { kind: 'uniprot', accession: 'P00001' },
          }),
        ],
      }
    );
    expect(out?.source).toBe('uniprot_xref');
  });

  it('re-throws AbortError', async () => {
    const aborted = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    await expect(
      resolveStructure('M', { dbXrefs: ['PDB:1TUP'] }, new AbortController().signal, {
        steps: [fakeStep('pdb_xref', 10, null, { throws: aborted })],
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('re-throws sidecar auth failures instead of reporting no biological match', async () => {
    const rejected = Object.assign(new Error('BAD_SESSION'), { name: 'SidecarAuthError' });
    await expect(
      resolveStructure('M', {}, new AbortController().signal, {
        steps: [fakeStep('protein_sequence', 25, null, { hintsRequired: [], throws: rejected })],
      })
    ).rejects.toMatchObject({ name: 'SidecarAuthError' });
  });

  it('re-throws sidecar provider failures instead of reporting no biological match', async () => {
    const rejected = Object.assign(new Error('UniProt unavailable'), {
      name: 'SidecarProviderError',
    });
    await expect(
      resolveStructure('M', {}, new AbortController().signal, {
        steps: [fakeStep('protein_sequence', 25, null, { hintsRequired: [], throws: rejected })],
      })
    ).rejects.toMatchObject({ name: 'SidecarProviderError' });
  });

  it.each(['UniProtKB:P00880', 'UniProtKB/Swiss-Prot:P00880', 'UniProtKB/TrEMBL:A0A0H3JZA8'])(
    'falls through an exact-sequence provider outage when curated xref %s can resolve',
    async (xref) => {
      const rejected = Object.assign(new Error('UniProt checksum lookup unavailable'), {
        name: 'SidecarProviderError',
      });
      const uniprotStep = fakeStep('uniprot_xref', 20, {
        source: 'uniprot_xref',
        identity: 1,
        structure: { kind: 'uniprot', accession: 'P00880' },
      });

      const out = await resolveStructure('M', { dbXrefs: [xref] }, new AbortController().signal, {
        steps: [
          fakeStep('protein_sequence', 5, null, { hintsRequired: [], throws: rejected }),
          uniprotStep,
        ],
      });

      expect(out?.source).toBe('uniprot_xref');
      expect(uniprotStep.resolve).toHaveBeenCalled();
    }
  );

  it('re-throws canonicalization mismatches instead of falling through to weaker steps', async () => {
    const rejected = Object.assign(new Error('renderer/sidecar mismatch'), {
      name: 'CanonicalizationMismatchError',
    });
    const weakerStep = fakeStep('gene_organism', 70, {
      source: 'gene_organism',
      identity: 0.8,
      structure: { kind: 'uniprot', accession: 'P99999' },
    });

    await expect(
      resolveStructure('M', {}, new AbortController().signal, {
        steps: [
          fakeStep('protein_sequence', 5, null, { hintsRequired: [], throws: rejected }),
          weakerStep,
        ],
      })
    ).rejects.toMatchObject({ name: 'CanonicalizationMismatchError' });
    expect(weakerStep.resolve).not.toHaveBeenCalled();
  });

  it('checks signal.aborted before each step', async () => {
    const controller = new AbortController();
    controller.abort();
    const step1 = vi.fn(async () => null);
    await expect(
      resolveStructure('M', { dbXrefs: ['PDB:1TUP'] }, controller.signal, {
        steps: [{ name: 'pdb_xref', priority: 10, hintsRequired: [], resolve: step1 }],
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(step1).not.toHaveBeenCalled();
  });
});

describe('BUILTIN_STEPS', () => {
  it('contains the planned steps in priority order — sequence-hash slots between curated xrefs and name-based searches', () => {
    expect(BUILTIN_STEPS.map((s) => s.name)).toEqual([
      'protein_sequence',
      'pdb_xref',
      'uniprot_xref',
      'protein_id',
      'refseq_xref',
      'geneid_xref',
      'locus_tag',
      'gene_sequence_overlap',
      'gene_organism',
    ]);
  });

  it('priorities are strictly ascending (chain order matches priority order)', () => {
    const priorities = BUILTIN_STEPS.map((s) => s.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeGreaterThan(priorities[i - 1]);
    }
  });
});

describe('defaultResolverStepsForRequest', () => {
  it('uses the protein resolver chain for legacy/protein requests', () => {
    expect(
      defaultResolverStepsForRequest({
        translation: 'M',
        hints: {},
      })
    ).toBe(BUILTIN_STEPS);
    expect(
      defaultResolverStepsForRequest({
        translation: 'M',
        moleculeType: 'protein',
        hints: {},
      })
    ).toBe(BUILTIN_STEPS);
  });

  it('uses the RCSB sequence resolver chain for RNA/DNA requests', () => {
    expect(
      defaultResolverStepsForRequest({
        translation: 'AUGCUAGCUAGCUAGCUAGCUAGCUAGCUA',
        moleculeType: 'rna',
        hints: {},
      })
    ).toBe(NON_PROTEIN_STEPS);
    expect(NON_PROTEIN_STEPS.map((step) => step.name)).toEqual(['rcsb_sequence']);
  });
});
