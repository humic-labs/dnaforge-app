import { describe, expect, it } from 'vitest';
import { parseResourceId, parseResourceRevisionId } from '@waypoint/workspace-revisions';
import {
  bindingEvidenceFreshness,
  defineScientificDocument,
  validateScientificChange,
  type RevisionPin,
  type ScientificReader,
  type ScientificSnapshot,
} from './index';

const id = (value: string) => {
  const result = parseResourceId(value);
  if (!result.ok) throw Error(value);
  return result.value;
};
let serial = 0;
function snapshot(resource: string, document: unknown): ScientificSnapshot {
  const revision = parseResourceRevisionId(`rr_${(++serial).toString(16).padStart(64, '0')}`);
  if (!revision.ok) throw Error('Fixture revision');
  const defined = defineScientificDocument(document);
  return {
    resourceId: id(resource),
    revisionId: revision.value,
    document: defined.document,
    scientificHash: defined.scientificHash,
    bindingInputHash: defined.bindingInputHash,
  };
}
const pin = (value: ScientificSnapshot): RevisionPin => ({
  resourceId: value.resourceId,
  revisionId: value.revisionId,
});
function reader(
  current: readonly ScientificSnapshot[],
  history: readonly ScientificSnapshot[] = [],
  files: readonly RevisionPin[] = []
): ScientificReader {
  const all = [...history, ...current];
  const key = (value: RevisionPin) => `${value.resourceId}:${value.revisionId}`;
  return {
    current: (resourceId) => current.find((value) => value.resourceId === resourceId) ?? null,
    revision: (value) => all.find((entry) => key(entry) === key(value)) ?? null,
    hasRevision: (value) =>
      all.some((entry) => key(entry) === key(value)) ||
      files.some((entry) => key(entry) === key(value)),
    listCurrent: () => current,
  };
}
const primerDoc = {
  formatVersion: 1,
  kind: 'primer',
  name: 'Forward',
  molecule: 'DNA',
  bases: 'ACGT',
  modifications: [],
  fields: {},
};
const sequenceDoc = {
  formatVersion: 1,
  kind: 'sequence',
  name: 'Donor',
  molecule: 'DNA',
  bases: 'ACGTACGT',
  topology: 'linear',
  annotations: [],
  fields: {},
};
const strainDoc = {
  formatVersion: 1,
  kind: 'strain',
  name: 'Host',
  taxon: 'Saccharomyces cerevisiae',
  fields: {},
};
function fixture() {
  const primer = snapshot('primer', primerDoc),
    target = snapshot('target', sequenceDoc);
  const binding = snapshot('binding', {
    formatVersion: 1,
    kind: 'primer-binding',
    primerId: primer.resourceId,
    target: pin(target),
    coordinates: { start: 0, end: 4, strand: 1 },
  });
  const evidence = snapshot('evidence', {
    formatVersion: 1,
    kind: 'binding-evidence',
    binding: pin(binding),
    primer: pin(primer),
    target: pin(target),
    algorithm: { name: 'alignment', version: '1', parameters: {} },
    outcome: 'valid',
    result: { matches: 4 },
  });
  return { primer, target, binding, evidence, all: [primer, target, binding, evidence] };
}
const issues = (
  after: ScientificReader,
  before = reader([]),
  changed = after.listCurrent().map((value) => value.resourceId)
) => validateScientificChange({ before, after, changedResourceIds: changed });

describe('scientific relationships and immutable assembly history', () => {
  it('accepts exact, owned scientific references including closed documents', () => {
    const f = fixture();
    expect(issues(reader(f.all))).toEqual([]);
  });
  it('rejects a dangling shared primer, wrong target kind and mismatched revision owner', () => {
    const f = fixture();
    expect(issues(reader([f.target, f.binding]))).toContainEqual(
      expect.objectContaining({ code: 'MISSING_REFERENCE' })
    );
    const wrong = snapshot('binding', { ...f.binding.document, target: pin(f.primer) });
    expect(issues(reader([f.primer, wrong]))).toContainEqual(
      expect.objectContaining({ code: 'WRONG_REFERENCE_KIND' })
    );
    const forged = snapshot('binding', {
      ...f.binding.document,
      target: { resourceId: f.primer.resourceId, revisionId: f.target.revisionId },
    });
    const dishonest = reader([f.primer, f.target, forged]);
    expect(issues({ ...dishonest, revision: () => f.target })).toContainEqual(
      expect.objectContaining({ code: 'REFERENCE_IDENTITY_MISMATCH' })
    );
  });
  it('validates coordinates on the pinned target and preserves circular origin wrapping', () => {
    const f = fixture(),
      circle = snapshot('circle', { ...sequenceDoc, topology: 'circular' });
    const wrapped = snapshot('wrap', {
      ...f.binding.document,
      target: pin(circle),
      coordinates: { start: 6, end: 2, strand: -1 },
    });
    expect(issues(reader([f.primer, circle, wrapped]))).toEqual([]);
    const outside = snapshot('binding', {
      ...f.binding.document,
      coordinates: { start: 0, end: 9, strand: 1 },
    });
    expect(issues(reader([f.primer, f.target, outside]))).toContainEqual(
      expect.objectContaining({ code: 'INVALID_COORDINATES' })
    );
    const backwards = snapshot('binding', {
      ...f.binding.document,
      coordinates: { start: 6, end: 2, strand: 1 },
    });
    expect(issues(reader([f.primer, f.target, backwards]))).toContainEqual(
      expect.objectContaining({ code: 'INVALID_COORDINATES' })
    );
  });
  it('rejects evidence attached to different binding inputs', () => {
    const f = fixture(),
      other = snapshot('other', sequenceDoc);
    const wrong = snapshot('evidence', { ...f.evidence.document, target: pin(other) });
    expect(issues(reader([f.primer, f.target, f.binding, other, wrong]))).toContainEqual(
      expect.objectContaining({ code: 'EVIDENCE_INPUT_MISMATCH' })
    );
  });
  it('pins an accepted assembly to historical sources and primers after current edits', () => {
    const f = fixture(),
      product = snapshot('product', sequenceDoc);
    const assembly = snapshot('assembly', {
      formatVersion: 1,
      kind: 'accepted-assembly',
      constructId: id('construct'),
      parent: null,
      sources: [pin(f.target)],
      primers: [pin(f.primer)],
      product: pin(product),
      recipe: { method: 'gibson', provenance: { retained: true } },
    });
    const editedPrimer = snapshot('primer', { ...primerDoc, bases: 'AAAA' });
    const editedSource = snapshot('target', { ...sequenceDoc, bases: 'CCCC' });
    const accepted = reader([editedPrimer, editedSource, product, assembly], [f.primer, f.target]);
    expect(issues(accepted)).toEqual([]);
    expect(accepted.revision(pin(f.target))?.document).toEqual(f.target.document);
    const rewritten = snapshot('assembly', {
      ...assembly.document,
      recipe: { method: 'golden_gate' },
    });
    expect(
      issues(
        reader([editedPrimer, editedSource, product, rewritten], [f.primer, f.target]),
        accepted,
        [assembly.resourceId]
      )
    ).toContainEqual(expect.objectContaining({ code: 'ASSEMBLY_HISTORY_IMMUTABLE' }));
  });
  it('rejects assembly parents from another construct and self-kind changes', () => {
    const f = fixture();
    const parent = snapshot('parent', {
      formatVersion: 1,
      kind: 'accepted-assembly',
      constructId: id('other-construct'),
      parent: null,
      sources: [pin(f.target)],
      primers: [],
      product: pin(f.target),
      recipe: {},
    });
    const child = snapshot('child', {
      ...parent.document,
      constructId: id('construct'),
      parent: pin(parent),
    });
    expect(issues(reader([f.target, parent, child]))).toContainEqual(
      expect.objectContaining({ code: 'EVIDENCE_INPUT_MISMATCH' })
    );
    const changedKind = snapshot('primer', strainDoc);
    expect(issues(reader([changedKind]), reader([f.primer]), [f.primer.resourceId])).toContainEqual(
      expect.objectContaining({ code: 'KIND_IMMUTABLE' })
    );
  });
  it('separates planned strain associations from observed assertions backed by accepted evidence', () => {
    const f = fixture(),
      strain = snapshot('strain', strainDoc);
    const planned = snapshot('association', {
      formatVersion: 1,
      kind: 'strain-sequence',
      strainId: strain.resourceId,
      sequence: pin(f.target),
      assertion: 'planned',
      evidence: [],
    });
    expect(issues(reader([strain, f.target, planned]))).toEqual([]);
    expect(() => snapshot('association', { ...planned.document, assertion: 'observed' })).toThrow();
    const missing = pin(f.evidence);
    const observed = snapshot('association', {
      ...planned.document,
      assertion: 'observed',
      evidence: [missing],
    });
    expect(issues(reader([strain, f.target, observed]))).toContainEqual(
      expect.objectContaining({ code: 'MISSING_REFERENCE' })
    );
    expect(issues(reader([strain, f.target, observed], [], [missing]))).toEqual([]);
  });
  it('rejects cyclic strain descent, including a cycle made by several new relationships', () => {
    const a = snapshot('a', strainDoc),
      b = snapshot('b', strainDoc);
    const ab = snapshot('ab', {
      formatVersion: 1,
      kind: 'strain-descent',
      strainId: a.resourceId,
      parent: pin(b),
      assertion: 'planned',
      evidence: [],
    });
    const ba = snapshot('ba', { ...ab.document, strainId: b.resourceId, parent: pin(a) });
    expect(issues(reader([a, b, ab]))).toEqual([]);
    expect(issues(reader([a, b, ab, ba]))).toContainEqual(
      expect.objectContaining({ code: 'STRAIN_DESCENT_CYCLE' })
    );
  });
});

describe('evidence freshness', () => {
  it('stales all uses of an edited shared primer without deleting their placements', () => {
    const f = fixture(),
      edited = snapshot('primer', { ...primerDoc, bases: 'AAAA' });
    const active = reader([edited, f.target, f.binding, f.evidence], [f.primer]);
    expect(bindingEvidenceFreshness(f.evidence.document, active)).toBe('stale');
    expect(issues(active, reader(f.all), [edited.resourceId])).toEqual([]);
    expect(active.current(f.binding.resourceId)?.document).toEqual(f.binding.document);
  });
  it('keeps names, annotations and lowercase edits out of binding invalidation', () => {
    const f = fixture();
    const primer = snapshot('primer', { ...primerDoc, name: 'Renamed', bases: 'acgt' });
    const target = snapshot('target', {
      ...sequenceDoc,
      name: 'Renamed donor',
      annotations: [{ start: 1, end: 4, name: 'feature' }],
    });
    expect(
      bindingEvidenceFreshness(
        f.evidence.document,
        reader([primer, target, f.binding, f.evidence], [f.primer, f.target])
      )
    ).toBe('current');
  });
  it('never presents a late worker result as current after target or placement changed', () => {
    const f = fixture(),
      target = snapshot('target', { ...sequenceDoc, bases: 'TTTTTTTT' });
    expect(
      bindingEvidenceFreshness(
        f.evidence.document,
        reader([f.primer, target, f.binding], [f.target])
      )
    ).toBe('stale');
    const moved = snapshot('binding', {
      ...f.binding.document,
      coordinates: { start: 4, end: 8, strand: 1 },
    });
    expect(
      bindingEvidenceFreshness(
        f.evidence.document,
        reader([f.primer, f.target, moved], [f.binding])
      )
    ).toBe('stale');
  });
  it('reports unavailable inputs rather than fresh evidence for a missing current entity', () => {
    const f = fixture();
    expect(
      bindingEvidenceFreshness(f.evidence.document, reader([f.target, f.binding], [f.primer]))
    ).toBe('unavailable');
  });
});
