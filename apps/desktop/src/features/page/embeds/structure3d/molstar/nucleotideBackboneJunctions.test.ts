import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { parsePDB } from 'molstar/lib/mol-io/reader/pdb/parser';
import { trajectoryFromPDB } from 'molstar/lib/mol-model-formats/structure/pdb';
import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { SortedArray } from 'molstar/lib/mol-data/int';
import { molecularSceneSelections } from './molecularSceneSelections';
import {
  resolveMolViewSpecAttachments,
  type AttachmentDocument,
  type AttachmentSceneNode,
} from './molecularConnections';
import pdb from './fixtures/nucleotide-backbone-junction-1ibm.pdb?raw';
import { requireConstructedInteractionGuides } from './molecularInteractionContext';
import { findDuplicateMolViewSpecGeometry } from './molViewSpecGeometry';

async function source() {
  const parsed = await parsePDB(pdb).run();
  if (parsed.isError) throw Error(parsed.message);
  return Structure.ofModel((await trajectoryFromPDB(parsed.result).run()).representative);
}

function scene(mode: 'full' | 'base-only' = 'full'): AttachmentDocument {
  return {
    root: {
      kind: 'root',
      children: [
        {
          kind: 'structure',
          children: [
            {
              kind: 'component',
              params: {
                selector: [
                  { auth_asym_id: 'C', beg_auth_seq_id: 31, end_auth_seq_id: 33 },
                  { auth_asym_id: 'C', beg_auth_seq_id: 37, end_auth_seq_id: 40 },
                ],
              },
              children: [{ kind: 'representation', params: { type: 'cartoon' } }],
            },
            {
              kind: 'component',
              ref: 'atomic-backbone-owner',
              params: { selector: { auth_asym_id: 'C', beg_auth_seq_id: 34, end_auth_seq_id: 36 } },
              children: [
                {
                  kind: 'representation',
                  params: { type: 'ball_and_stick' },
                  custom: {
                    molstar_representation_params: {
                      dnaforgeNucleotideAtomicMode: mode,
                      includeParent: false,
                    },
                  },
                },
                {
                  kind: 'representation',
                  params: { type: 'cartoon' },
                  custom: {
                    dnaforge_nucleotide_generated: true,
                    molstar_representation_params: { visuals: ['dnaforge-nucleotide-base-plane'] },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function owner(doc: AttachmentDocument): AttachmentSceneNode {
  return doc.root!.children![0].children!.find((n) => n.ref === 'atomic-backbone-owner')!;
}

function compile(doc: AttachmentDocument, native: Structure) {
  return resolveMolViewSpecAttachments(
    molstarPluginFixture({
      managers: { structure: { hierarchy: { current: { structures: [] } } } },
    }),
    doc,
    () => native
  );
}

function namesAt(native: Structure, selector: unknown, position: number) {
  const selected = molecularSceneSelections(native).select(selector as never);
  return selected.units
    .flatMap((unit) =>
      Unit.isAtomic(unit)
        ? Array.from(unit.elements)
            .filter(
              (atom) =>
                unit.model.atomicHierarchy.residues.auth_seq_id.value(unit.residueIndex[atom]) ===
                position
            )
            .map((atom) => unit.model.atomicHierarchy.atoms.label_atom_id.value(atom))
        : []
    )
    .sort();
}

describe('native nucleotide backbone to context trace junctions', () => {
  it('retains strict authored membership while comparing independently source-compiled authority', async () => {
    const native = await source();
    const current = scene();
    current.root!.children![0].children![0].params!.selector = [
      { auth_asym_id: 'C', beg_auth_seq_id: 31, end_auth_seq_id: 32 },
      { auth_asym_id: 'C', beg_auth_seq_id: 39, end_auth_seq_id: 40 },
    ];
    owner(current).params!.selector = {
      auth_asym_id: 'C',
      beg_auth_seq_id: 34,
      end_auth_seq_id: 37,
    };
    owner(current).custom = {
      dnaforge_interaction_context: 'native-interaction-context-v1',
      dnaforge_binding_region: {
        target: { auth_asym_id: 'C', auth_seq_id: 34 },
        partner: { auth_asym_id: 'C', auth_seq_id: 35 },
        detail: structuredClone(owner(current).params!.selector),
      },
    };
    const restored = structuredClone(current);
    restored.root!.children![0].children![0].params!.selector = { auth_asym_id: 'C' };
    const encoded = (d: AttachmentDocument) => JSON.stringify({ metadata: { version: '1' }, ...d });
    expect(() =>
      requireConstructedInteractionGuides(encoded(current), encoded(restored))
    ).not.toThrow();
    const proposed = compile(restored, native);
    expect(() => requireConstructedInteractionGuides(encoded(current), encoded(proposed))).toThrow(
      /must be constructed/
    );
    expect(() =>
      requireConstructedInteractionGuides(encoded(compile(current, native)), encoded(proposed))
    ).not.toThrow();
    const forged = structuredClone(restored);
    owner(forged).params!.selector = { auth_asym_id: 'C' };
    expect(() => requireConstructedInteractionGuides(encoded(current), encoded(forged))).toThrow(
      /must be constructed/
    );
  });

  it('keeps a full cartoon restoration free of repeated native nucleotide attachments', async () => {
    const native = await source();
    const original = scene();
    original.root!.children![0].children![0].params!.selector = { auth_asym_id: 'C' };
    original.root!.children![0].children![0].children![0].custom = {
      molstar_representation_params: { visuals: ['polymer-trace', 'nucleotide-ring'] },
    };
    owner(original).params!.selector = {
      auth_asym_id: 'C',
      beg_auth_seq_id: 34,
      end_auth_seq_id: 37,
    };
    owner(original).children!.push({
      kind: 'representation',
      params: { type: 'cartoon' },
      custom: {
        dnaforge_nucleotide_generated: true,
        molstar_representation_params: { visuals: ['dnaforge-nucleotide-connector'] },
      },
    });
    const result = compile(original, native);
    const components = result.root!.children![0].children!.map((co) => ({
      cell: {
        obj: {
          data: molecularSceneSelections(native).select(co.params!.selector as never),
          label: co.ref ?? 'cartoon',
        },
      },
      representations: co.children!.map((re) => {
        const props = {
          alpha: 1,
          ...((re.custom?.molstar_representation_params as Record<string, unknown>) ?? {}),
        };
        return {
          cell: {
            params: {
              values: { type: { name: String(re.params!.type).replace(/_/g, '-'), params: props } },
            },
            obj: { data: { repr: { state: { visible: true, alphaFactor: 1 }, props } } },
          },
        };
      }),
    }));
    const plugin = molstarPluginFixture({
      managers: { structure: { hierarchy: { current: { structures: [{ components }] } } } },
    });
    expect(findDuplicateMolViewSpecGeometry(plugin)).toEqual([]);
  });

  it('restores a missing native cartoon route to an already shown stem before closing the atomic boundary', async () => {
    const native = await source();
    const original = scene();
    original.root!.children![0].children![0].params!.selector = [
      { auth_asym_id: 'C', beg_auth_seq_id: 31, end_auth_seq_id: 32 },
      { auth_asym_id: 'C', beg_auth_seq_id: 39, end_auth_seq_id: 40 },
    ];
    owner(original).params!.selector = {
      auth_asym_id: 'C',
      beg_auth_seq_id: 34,
      end_auth_seq_id: 37,
    };
    const result = compile(original, native);
    const cartoon = result.root!.children![0].children![0];
    const selected = molecularSceneSelections(native).select(cartoon.params!.selector as never);
    const covered = new Set(
      selected.units.flatMap((unit) =>
        Unit.isAtomic(unit)
          ? Array.from(unit.polymerElements, (atom) =>
              unit.model.atomicHierarchy.residues.auth_seq_id.value(unit.residueIndex[atom])
            )
          : []
      )
    );
    expect(covered.has(33)).toBe(true);
    expect(covered.has(38)).toBe(true);
    expect(covered.has(34)).toBe(false);
    expect(namesAt(native, owner(result).params!.selector, 33)).toEqual(["O3'"]);
    expect(namesAt(native, owner(result).params!.selector, 38)).toEqual([
      "C3'",
      "C4'",
      "C5'",
      "O3'",
      "O5'",
      'P',
    ]);
    expect(compile(result, native)).toEqual(result);
    expect(original.root!.children![0].children![0].params!.selector).toHaveLength(2);
  });
  it('completes only the real neighboring backbone path inside the original atomic owner', async () => {
    const native = await source();
    const original = scene();
    const computedRegion = {
      target: { auth_asym_id: 'C', auth_seq_id: 34 },
      partner: { auth_asym_id: 'C', auth_seq_id: 35 },
      seed: { auth_asym_id: 'C', auth_seq_id: 36 },
      detail: structuredClone(owner(original).params!.selector),
    };
    owner(original).custom = { dnaforge_binding_region: computedRegion };
    const result = compile(original, native);
    const selected = owner(result).params!.selector;
    expect(namesAt(native, selected, 33)).toEqual(["O3'"]);
    expect(namesAt(native, selected, 37)).toEqual(["C3'", "C4'", "C5'", "O3'", "O5'", 'P']);
    expect(namesAt(native, selected, 38)).toEqual([]);
    expect(result.root!.children![0].children).toHaveLength(2);
    expect(owner(result).custom?.dnaforge_nucleotide_junction_atoms).toBeDefined();
    expect(owner(result).custom?.dnaforge_binding_region).toEqual({
      ...computedRegion,
      detail: selected,
    });
    const planes = owner(result).children![1].custom!.molstar_representation_params as {
      dnaforgeNucleotideExclude?: unknown[];
    };
    expect(planes.dnaforgeNucleotideExclude).toBeDefined();
    expect(compile(result, native)).toEqual(result);
    expect(owner(original).custom).toEqual({ dnaforge_binding_region: computedRegion });
  });

  it('does not invent the outgoing connection when its native phosphate coordinate is absent', async () => {
    const native = await source();
    const incomplete = Structure.create(
      native.units.map((unit) => {
        if (!Unit.isAtomic(unit)) return unit;
        const h = unit.model.atomicHierarchy;
        return unit.getChild(
          SortedArray.ofSortedArray(
            Array.from(unit.elements).filter(
              (atom) =>
                !(
                  h.chains.auth_asym_id.value(unit.chainIndex[atom]) === 'C' &&
                  h.residues.auth_seq_id.value(unit.residueIndex[atom]) === 37 &&
                  h.atoms.label_atom_id.value(atom) === 'P'
                )
            )
          )
        );
      })
    );
    const result = compile(scene(), incomplete);
    expect(namesAt(incomplete, owner(result).params!.selector, 37)).toEqual([]);
  });

  it('preserves the base-only schematic view without adding sugar or phosphate atoms', async () => {
    const native = await source();
    const original = scene('base-only');
    expect(compile(original, native)).toEqual(original);
  });
});
