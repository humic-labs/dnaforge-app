// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildCustomGeneticCode,
  type Annotation,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import {
  planGeneticCodePaste,
  preserveInsertedGeneticCodes,
  reReadFragmentUnderDestinationCode,
  reReadInsertedAnnotations,
} from './genetic-code-paste';
import {
  buildRichSequenceFragmentFromSelection,
  richSequenceFragmentForEditor,
  type RichSequenceFragment,
} from './rich-sequence-clipboard';

const SOURCE_SEQUENCE = 'ATGTGAAAATTTGGGCCCAAATTTGGGTAA';

function cds(overrides: Partial<Annotation> = {}): Annotation {
  return { name: 'cox1', type: 'CDS', start: 1, end: 30, direction: 1, ...overrides };
}

function copy({
  annotations = [],
  sourceGeneticCode,
  range = { start: 0, end: 30 },
}: {
  annotations?: Annotation[];
  sourceGeneticCode?: GeneticCodeSpec;
  range?: { start: number; end: number };
} = {}): RichSequenceFragment {
  return buildRichSequenceFragmentFromSelection({
    sourceId: 'src',
    sourceName: 'yeast chrMT',
    sourceSequence: SOURCE_SEQUENCE,
    sourceAnnotations: annotations,
    ...(sourceGeneticCode !== undefined ? { sourceGeneticCode } : {}),
    range,
    orientation: 'forward',
  }).fragment;
}

describe('copying stamps the source genetic code onto the fragment', () => {
  it('records the record code and whether coding sequence was touched', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 3 });
    expect(fragment.sourceGeneticCode).toBe(3);
    expect(fragment.sourceHadCodingContext).toBe(true);
    expect(fragment.version).toBe(2);
  });

  it('writes the effective code onto each carried coding feature', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 3 });
    expect(fragment.annotations[0].qualifiers?.transl_table).toBe('3');
  });

  it('keeps a feature declaration that disagrees with its record', () => {
    const fragment = copy({
      annotations: [cds({ qualifiers: { transl_table: ['1'] } })],
      sourceGeneticCode: 3,
    });
    expect(fragment.annotations[0].qualifiers?.transl_table).toBe('1');
  });

  it('reports no coding context for a selection outside every gene', () => {
    const fragment = copy({
      annotations: [cds({ start: 1, end: 9 })],
      range: { start: 20, end: 30 },
      sourceGeneticCode: 3,
    });
    expect(fragment.sourceHadCodingContext).toBe(false);
  });

  it('leaves an ordinary standard-code copy completely unmarked', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 1 });
    expect(fragment.annotations[0].qualifiers?.transl_table).toBeUndefined();
    expect(fragment.sourceGeneticCode).toBe(1);
  });

  it('leaves a non-coding feature unstamped', () => {
    const fragment = copy({
      annotations: [{ ...cds(), type: 'misc_feature' }],
      sourceGeneticCode: 3,
    });
    expect(fragment.annotations[0].qualifiers?.transl_table).toBeUndefined();
  });
});

describe('planGeneticCodePaste', () => {
  it('stays silent when the codes match', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 3 });
    expect(planGeneticCodePaste(fragment, 3).kind).toBe('silent');
  });

  it('stays silent between the standard and bacterial codes', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 11 });
    expect(planGeneticCodePaste(fragment, 1).kind).toBe('silent');
  });

  it('stays silent for bare bases from outside any gene', () => {
    const fragment = copy({
      annotations: [cds({ start: 1, end: 9 })],
      range: { start: 20, end: 30 },
      sourceGeneticCode: 3,
    });
    expect(planGeneticCodePaste(fragment, 1).kind).toBe('silent');
  });

  it('stays silent for a version-1 fragment with no recorded code', () => {
    const fragment = copy({ annotations: [cds()] });
    const withoutCode: RichSequenceFragment = {
      ...fragment,
      version: 1,
      annotations: fragment.annotations.map(({ qualifiers: _dropped, ...rest }) => rest),
    };
    delete (withoutCode as { sourceGeneticCode?: number }).sourceGeneticCode;
    expect(planGeneticCodePaste(withoutCode, 3).kind).toBe('silent');
  });

  it('gives a plain notice for coding bases with no feature attached', () => {
    const fragment = copy({
      annotations: [cds()],
      range: { start: 3, end: 12 },
      sourceGeneticCode: 3,
    });
    const basesOnly: RichSequenceFragment = { ...fragment, annotations: [] };
    const plan = planGeneticCodePaste(basesOnly, 1);
    expect(plan.kind).toBe('notice');
    expect(plan.message).toContain('3 — Yeast Mitochondrial');
    expect(plan.message).toContain('1 — Standard');
    expect(plan.conflictingFeatureNames).toEqual([]);
  });

  it('reports a conflict when coding features cross a code boundary', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 3 });
    const plan = planGeneticCodePaste(fragment, 1);
    expect(plan.kind).toBe('conflict');
    expect(plan.sourceGeneticCode).toBe(3);
    expect(plan.destinationGeneticCode).toBe(1);
    expect(plan.conflictingFeatureNames).toEqual(['cox1']);
    expect(plan.message).toContain('1 coding feature');
    expect(plan.message).toContain('keeps its');
  });

  it('names the feature code, not the record code, for a mixed source', () => {
    const fragment = copy({
      annotations: [cds({ qualifiers: { transl_table: ['4'] } })],
      sourceGeneticCode: 1,
    });
    const plan = planGeneticCodePaste(fragment, 1);
    expect(plan.kind).toBe('conflict');
    expect(plan.sourceGeneticCode).toBe(4);
  });

  it('pluralizes for more than one conflicting feature', () => {
    const fragment = copy({
      annotations: [cds(), cds({ name: 'cox2', start: 1, end: 15 })],
      sourceGeneticCode: 3,
    });
    const plan = planGeneticCodePaste(fragment, 1);
    expect(plan.conflictingFeatureNames).toEqual(['cox2', 'cox1']);
    expect(plan.message).toContain('2 coding features');
    expect(plan.message).toContain('keep their');
  });

  it('ignores an unpublished declared table rather than warning about nonsense', () => {
    const fragment = copy({
      annotations: [cds({ qualifiers: { transl_table: ['7'] } })],
      sourceGeneticCode: 1,
    });
    expect(planGeneticCodePaste(fragment, 1).kind).toBe('silent');
  });
});

describe('reReadFragmentUnderDestinationCode', () => {
  it('drops the carried table so the feature inherits the destination code', () => {
    const fragment = richSequenceFragmentForEditor(
      copy({ annotations: [cds()], sourceGeneticCode: 3 })
    );
    expect(fragment.annotations[0].qualifiers?.transl_table).toEqual(['3']);

    const reRead = reReadFragmentUnderDestinationCode(fragment);
    expect(reRead.annotations[0].qualifiers?.transl_table).toBeUndefined();
    expect(reRead.annotations[0].name).toBe('cox1');
    expect(reRead.sequence).toBe(fragment.sequence);
  });

  it('keeps other qualifiers and leaves untouched features alone', () => {
    const fragment = richSequenceFragmentForEditor(
      copy({
        annotations: [
          cds({ qualifiers: { product: ['cytochrome oxidase'] } }),
          { ...cds({ name: 'promoter1' }), type: 'promoter' },
        ],
        sourceGeneticCode: 3,
      })
    );
    const reRead = reReadFragmentUnderDestinationCode(fragment);
    const coding = reRead.annotations.find((a) => a.type === 'CDS')!;
    expect(coding.qualifiers?.product).toEqual(['cytochrome oxidase']);
    expect(coding.qualifiers?.transl_table).toBeUndefined();
    const promoter = reRead.annotations.find((a) => a.type === 'promoter')!;
    expect(promoter.qualifiers).toBeUndefined();
  });
});

describe('reReadInsertedAnnotations', () => {
  const plan = planGeneticCodePaste(copy({ annotations: [cds()], sourceGeneticCode: 3 }), 1);

  function pasted(overrides: Partial<Annotation> = {}): Annotation {
    return {
      name: 'cox1',
      type: 'CDS',
      start: 11,
      end: 40,
      direction: 1,
      qualifiers: { transl_table: ['3'] },
      ...overrides,
    };
  }

  it('drops the declared table on a feature the paste inserted', () => {
    const next = reReadInsertedAnnotations([pasted()], plan, { start: 10, end: 40 });
    expect(next).not.toBeNull();
    expect(next![0].qualifiers).toBeUndefined();
  });

  it('leaves a same-named feature outside the inserted range alone', () => {
    const outside = pasted({ start: 500, end: 529 });
    expect(reReadInsertedAnnotations([outside], plan, { start: 10, end: 40 })).toBeNull();
  });

  it('leaves a feature the plan never named alone', () => {
    const other = pasted({ name: 'atp6' });
    expect(reReadInsertedAnnotations([other], plan, { start: 10, end: 40 })).toBeNull();
  });

  it('leaves a non-coding feature alone', () => {
    const promoter = pasted({ type: 'promoter' });
    expect(reReadInsertedAnnotations([promoter], plan, { start: 10, end: 40 })).toBeNull();
  });

  it('is idempotent — a second run finds nothing to change', () => {
    const first = reReadInsertedAnnotations([pasted()], plan, { start: 10, end: 40 });
    expect(reReadInsertedAnnotations(first!, plan, { start: 10, end: 40 })).toBeNull();
  });

  it('skips a feature whose table no longer conflicts', () => {
    const bacterial = pasted({ qualifiers: { transl_table: ['11'] } });
    expect(reReadInsertedAnnotations([bacterial], plan, { start: 10, end: 40 })).toBeNull();
  });

  it('does nothing for a silent or notice plan', () => {
    const silent = planGeneticCodePaste(copy({ annotations: [cds()], sourceGeneticCode: 1 }), 1);
    expect(reReadInsertedAnnotations([pasted()], silent, null)).toBeNull();
  });

  it('falls back to name and table matching when the inserted range is unknown', () => {
    const next = reReadInsertedAnnotations([pasted({ start: 500, end: 529 })], plan, null);
    expect(next).not.toBeNull();
    expect(next![0].qualifiers).toBeUndefined();
  });

  it('keeps other qualifiers on a feature it re-reads', () => {
    const withProduct = pasted({
      qualifiers: { transl_table: ['3'], product: ['cytochrome oxidase'] },
    });
    const next = reReadInsertedAnnotations([withProduct], plan, { start: 10, end: 40 });
    expect(next![0].qualifiers).toEqual({ product: ['cytochrome oxidase'] });
  });
});

describe('preserveInsertedGeneticCodes', () => {
  const fragment = copy({ annotations: [cds()], sourceGeneticCode: 1 });
  const editor = richSequenceFragmentForEditor(fragment);
  const plan = planGeneticCodePaste(fragment, 3);

  it('stamps the source code on the features the warning named', () => {
    expect(plan.kind).toBe('conflict');
    const preserved = preserveInsertedGeneticCodes(editor, plan);
    expect(preserved.annotations[0].qualifiers?.transl_table).toEqual(['1']);
  });

  it('makes the conflict message true: the feature really keeps its own code', () => {
    const preserved = preserveInsertedGeneticCodes(editor, plan);
    const inserted = preserved.annotations[0];
    expect(plan.message).toContain('the protein is unchanged');
    expect(inserted.qualifiers?.transl_table?.[0]).toBe(String(plan.sourceGeneticCode));
  });

  it('leaves a feature that already declares a code alone', () => {
    const declared = copy({
      annotations: [cds({ qualifiers: { transl_table: ['4'] } })],
      sourceGeneticCode: 4,
    });
    const own = richSequenceFragmentForEditor(declared);
    const ownPlan = planGeneticCodePaste(declared, 3);
    expect(
      preserveInsertedGeneticCodes(own, ownPlan).annotations[0].qualifiers?.transl_table
    ).toEqual(['4']);
  });

  it('writes nothing for a silent or notice plan', () => {
    const same = planGeneticCodePaste(fragment, 1);
    expect(preserveInsertedGeneticCodes(editor, same)).toBe(editor);
  });

  it('leaves a non-coding feature alone', () => {
    const misc = copy({ annotations: [{ ...cds(), type: 'misc_feature' }], sourceGeneticCode: 1 });
    const miscEditor = richSequenceFragmentForEditor(misc);
    expect(preserveInsertedGeneticCodes(miscEditor, planGeneticCodePaste(misc, 3))).toBe(
      miscEditor
    );
  });

  it('round-trips: what it stamps, re-reading takes back off', () => {
    const preserved = preserveInsertedGeneticCodes(editor, plan);
    const reread = reReadFragmentUnderDestinationCode(preserved);
    expect(reread.annotations[0].qualifiers?.transl_table).toBeUndefined();
  });
});

describe('pasting across a custom genetic code', () => {
  function amber(overrides: { id?: string; residue?: string; name?: string } = {}) {
    const residue = overrides.residue ?? 'pAzF';
    const built = buildCustomGeneticCode({
      id: overrides.id ?? 'gc-3f2a9c1e',
      revision: 1,
      name: overrides.name ?? `Amber suppression (${residue} at TAG)`,
      base: 11,
      changes: { TAG: { kind: 'residue', residue } },
      residues: [{ abbreviation: residue, name: `${residue} full name` }],
    });
    if (!built.ok) throw new Error(built.issues.map((issue) => issue.message).join('; '));
    return built.definition;
  }

  it('carries the custom code on the fragment but cannot stamp it on a feature', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: amber() });
    expect(fragment.sourceGeneticCode).toEqual(amber());
    expect(fragment.annotations[0].qualifiers?.transl_table).toBeUndefined();
  });

  it('survives the clipboard as text', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: amber() });
    const reread = JSON.parse(JSON.stringify(fragment)) as typeof fragment;
    expect(planGeneticCodePaste(reread, 11).kind).toBe('conflict');
  });

  it('warns without claiming the protein is unchanged, since nothing can carry the code', () => {
    const plan = planGeneticCodePaste(
      copy({ annotations: [cds()], sourceGeneticCode: amber() }),
      11
    );
    expect(plan.kind).toBe('conflict');
    expect(plan.preservable).toBe(false);
    expect(plan.message).toContain('Amber suppression (pAzF at TAG)');
    expect(plan.message).not.toMatch(/unchanged/);
    expect(plan.message).toMatch(/now read by/);
  });

  it('writes nothing onto the pasted features for a custom source', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: amber() });
    const editor = richSequenceFragmentForEditor(fragment);
    const plan = planGeneticCodePaste(fragment, 11);
    expect(preserveInsertedGeneticCodes(editor, plan)).toBe(editor);
  });

  it('stays silent pasting into a record on the same custom code', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: amber() });
    expect(
      planGeneticCodePaste(fragment, amber({ id: 'gc-99999999', name: 'Same, renamed' })).kind
    ).toBe('silent');
  });

  it('warns between two custom codes that put different residues at TAG', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: amber() });
    expect(planGeneticCodePaste(fragment, amber({ residue: 'pAcF' })).kind).toBe('conflict');
  });

  it('still preserves a published code pasted INTO a custom-coded record', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: 4 });
    const plan = planGeneticCodePaste(fragment, amber());
    expect(plan.kind).toBe('conflict');
    expect(plan.preservable).toBe(true);
    expect(plan.message).toContain('unchanged');
    const preserved = preserveInsertedGeneticCodes(richSequenceFragmentForEditor(fragment), plan);
    expect(preserved.annotations[0].qualifiers?.transl_table).toEqual(['4']);
  });

  it('ignores a damaged custom code on a fragment rather than trusting it', () => {
    const fragment = copy({ annotations: [cds()], sourceGeneticCode: amber() });
    const damaged = { ...fragment, sourceGeneticCode: { ...amber(), residues: [] } };
    expect(planGeneticCodePaste(damaged, 11).kind).toBe('silent');
  });
});
