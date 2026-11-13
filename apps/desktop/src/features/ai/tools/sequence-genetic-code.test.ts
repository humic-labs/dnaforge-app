   
                                                          
  
                                                                                
                                                                                
                                                                               
                                             
   

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';

vi.mock('./path-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./path-utils')>();
  return { ...actual, loadSequenceDocumentBiologyFile: vi.fn() };
});
vi.mock('../../sequence/set-sequence-genetic-code', () => ({
  setSequenceGeneticCodeOnDocument: vi.fn(),
}));

const settings = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('../../../db', () => ({
  getSetting: vi.fn(async (key: string) => settings.values.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings.values.set(key, value);
  }),
}));

import {
  createGetSequenceGeneticCodeTool as originalCreateGetSequenceGeneticCodeTool,
  createSetSequenceGeneticCodeTool as originalCreateSetSequenceGeneticCodeTool,
} from './sequence-genetic-code';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import {
  getSequenceGeneticCodeOutputSchema,
  setSequenceGeneticCodeOutputSchema,
} from './sequence-output-schemas';
const createGetSequenceGeneticCodeTool = checkedSequenceToolFactory(
  originalCreateGetSequenceGeneticCodeTool,
  getSequenceGeneticCodeOutputSchema
);
const createSetSequenceGeneticCodeTool = checkedSequenceToolFactory(
  originalCreateSetSequenceGeneticCodeTool,
  setSequenceGeneticCodeOutputSchema
);

import { loadSequenceDocumentBiologyFile } from './path-utils';
import { setSequenceGeneticCodeOnDocument } from '../../sequence/public/set-sequence-genetic-code';
import { execTool } from './test-helpers';

function cds(overrides: Partial<Annotation> = {}): Annotation {
  return { name: 'cox1', type: 'CDS', start: 1, end: 9, direction: 1, ...overrides };
}

function record(annotations: Annotation[] = []): AnnotatedSequence {
  return {
    id: 'doc',
    name: 'chrMT',
    sequence: 'ATGTGAAAA',
    length: 9,
    annotations,
    circular: true,
  };
}

function loads(sequence: AnnotatedSequence): void {
  vi.mocked(loadSequenceDocumentBiologyFile).mockResolvedValue({
    documentId: 'doc',
    sourcePath: '/ws/chrMT.gb',
    biology: { format: 'genbank', sequence, features: [] },
  } as never);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are untyped at the seam
type AnyResult = any;

describe('get_sequence_genetic_code', () => {
  beforeEach(() => vi.mocked(loadSequenceDocumentBiologyFile).mockReset());

  it('reports the code a record declares, and how it knows', async () => {
    loads(record([cds({ qualifiers: { transl_table: ['3'] } })]));
    const result = await execTool<AnyResult>(createGetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
    });

    expect(result.ok).toBe(true);
    expect(result.geneticCode).toBe(3);
    expect(result.label).toBe('3 — Yeast Mitochondrial');
    expect(result.basis).toBe('declared');
    expect(result.basisExplanation).toMatch(/declares this one/);
    expect(result.declaredByFeatures).toEqual([
      { geneticCode: 3, label: '3 — Yeast Mitochondrial', codingFeatures: 1 },
    ]);
    expect(result.mixed).toBe(false);
  });

  it('lists every published code so a caller cannot invent an id', async () => {
    loads(record());
    const result = await execTool<AnyResult>(createGetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
    });
    const ids = result.publishedGeneticCodes.map((c: { id: number }) => c.id);
    expect(ids).toHaveLength(27);
    expect(ids).toContain(33);
                                                                                   
    expect(ids).not.toContain(7);
    expect(ids).not.toContain(8);
  });

  it('says a mixed record is mixed, with the count behind each code', async () => {
    loads(
      record([
        cds({ qualifiers: { transl_table: ['3'] } }),
        cds({ name: 'cox2', qualifiers: { transl_table: ['3'] } }),
        cds({ name: 'nuc', qualifiers: { transl_table: ['1'] } }),
      ])
    );
    const result = await execTool<AnyResult>(createGetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
    });
    expect(result.mixed).toBe(true);
    expect(result.geneticCode).toBe(3);
    expect(result.declaredByFeatures).toEqual([
      { geneticCode: 1, label: '1 — Standard', codingFeatures: 1 },
      { geneticCode: 3, label: '3 — Yeast Mitochondrial', codingFeatures: 2 },
    ]);
  });

  it('flags an organellar record that declares nothing, rather than guessing', async () => {
    loads(
      record([
        {
          name: 'source',
          type: 'source',
          start: 1,
          end: 9,
          direction: 0,
          qualifiers: { organelle: ['mitochondrion'] },
        },
      ])
    );
    const result = await execTool<AnyResult>(createGetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
    });
    expect(result.needsUserChoice).toBe(true);
    expect(result.organelle).toBe('mitochondrion');
    expect(result.geneticCode).toBe(1);
  });

  it('always warns that a declaring feature outranks the file answer', async () => {
    loads(record());
    const result = await execTool<AnyResult>(createGetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
    });
    expect(result.note).toMatch(/declares its own \/transl_table is always read by that/);
  });

  it('fails structurally when the document is not found', async () => {
                                                                               
                                                                             
                                                                               
                                                                              
                            
    vi.mocked(loadSequenceDocumentBiologyFile).mockReset();
    const result = await execTool<AnyResult>(createGetSequenceGeneticCodeTool([]), {
      documentId: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('SEQUENCE_NOT_FOUND');
    expect(result.retriable).toBe(false);
    expect(result.stateChanged).toBe(false);
  });
});

describe('set_sequence_genetic_code', () => {
  beforeEach(() => vi.mocked(setSequenceGeneticCodeOnDocument).mockReset());

  function succeeds(featuresDeclaringTheirOwnCode: string[] = []): void {
    vi.mocked(setSequenceGeneticCodeOnDocument).mockResolvedValue({
      ok: true,
      resolved: {
        code: 3,
        basis: 'chosen',
        declaredCodes: [],
        mixed: false,
        needsUserChoice: false,
      },
      featuresDeclaringTheirOwnCode,
      savedToFile: true,
    });
  }

  it('records a code and reports it was written', async () => {
    succeeds();
    const result = await execTool<AnyResult>(createSetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
      geneticCode: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.geneticCode).toBe(3);
    expect(result.label).toBe('3 — Yeast Mitochondrial');
    expect(result.savedToFile).toBe(true);
    expect(vi.mocked(setSequenceGeneticCodeOnDocument).mock.calls[0][0]).toMatchObject({
      documentId: 'doc',
      geneticCode: 3,
    });
  });

  it('names the features that keep reading by their own code', async () => {
                                                                               
                                                                        
    succeeds(['cox1', 'cox2']);
    const result = await execTool<AnyResult>(createSetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
      geneticCode: 3,
    });
    expect(result.featuresStillReadingByTheirOwnCode).toEqual(['cox1', 'cox2']);
  });

  it('refuses an unpublished id before touching the file', async () => {
    const result = await execTool<AnyResult>(createSetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
      geneticCode: 7,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNKNOWN_GENETIC_CODE');
    expect(result.stateChanged).toBe(false);
    expect(setSequenceGeneticCodeOnDocument).not.toHaveBeenCalled();
  });

  it('accepts null to remove an override', async () => {
    vi.mocked(setSequenceGeneticCodeOnDocument).mockResolvedValue({
      ok: true,
      resolved: {
        code: 1,
        basis: 'default',
        declaredCodes: [],
        mixed: false,
        needsUserChoice: false,
      },
      featuresDeclaringTheirOwnCode: [],
      savedToFile: true,
    });
    const result = await execTool<AnyResult>(createSetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
      geneticCode: null,
    });
    expect(result.ok).toBe(true);
    expect(result.label).toBeNull();
    expect(result.resolvedGeneticCode).toBe(1);
  });

  it('reports unsaved edits as not-retriable, with no state change', async () => {
    vi.mocked(setSequenceGeneticCodeOnDocument).mockResolvedValue({
      ok: false,
      error: 'unsaved_edits',
      message: 'That sequence document has unsaved edits.',
    });
    const result = await execTool<AnyResult>(createSetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
      geneticCode: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNSAVED_EDITS');
    expect(result.retriable).toBe(false);
    expect(result.stateChanged).toBe(false);
  });

  it('reports a write failure as retriable with unknown state', async () => {
                                                                                 
                                 
    vi.mocked(setSequenceGeneticCodeOnDocument).mockResolvedValue({
      ok: false,
      error: 'write_failed',
      message: 'disk full',
    });
    const result = await execTool<AnyResult>(createSetSequenceGeneticCodeTool([]), {
      documentId: 'doc',
      geneticCode: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.stateChanged).toBe('unknown');
  });
});
