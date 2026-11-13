import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { SortedArray } from 'molstar/lib/mol-data/int';
import { isNucleic, NucleicBackboneAtoms } from 'molstar/lib/mol-model/structure/model/types';
import { representationProps } from 'molstar/lib/extensions/mvs/load-helpers';
import {
  nucleotideGroupColors,
  NUCLEOTIDE_BASE_PLANE_VISUAL,
  type MolecularProfileNode as Node,
} from './nucleotidePresentationSettings';
import { molecularSceneSelections } from './molecularSceneSelections';
import { molecularAtomSelector } from './molecularConnections';
import {
  molecularRepresentationVisible,
  molecularColorIsElementPalette,
} from './molecularDisplayGroups';

const key = (unit: Unit.Atomic, atom: number) => `${unit.id}:${unit.residueIndex[atom]}`;
function residues(source: Structure, carbonOnly = false): Set<string> {
  const result = new Set<string>();
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    const h = unit.model.atomicHierarchy;
    for (const atom of Array.from(unit.elements)) {
      if (!isNucleic(h.derived.residue.moleculeType[unit.residueIndex[atom]])) continue;
      if (carbonOnly && h.atoms.type_symbol.value(atom) !== 'C') continue;
      result.add(key(unit, atom));
    }
  }
  return result;
}
function subset(source: Structure, keys: ReadonlySet<string>): Structure {
  const units: Unit[] = [];
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    const atoms = Array.from(unit.elements).filter((atom) => keys.has(key(unit, atom)));
    if (atoms.length) units.push(unit.getChild(SortedArray.ofSortedArray(atoms)));
  }
  return Structure.create(units, { parent: source });
}
function withoutResidues(source: Structure, keys: ReadonlySet<string>): Structure {
  const units: Unit[] = [];
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) {
      units.push(unit);
      continue;
    }
    const atoms = Array.from(unit.elements).filter((atom) => !keys.has(key(unit, atom)));
    if (atoms.length) units.push(unit.getChild(SortedArray.ofSortedArray(atoms)));
  }
  return Structure.create(units, { parent: source });
}
function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return new Set([...a].filter((value) => b.has(value)));
}
function alpha(node: Node): number {
  return (representationProps(node as never).type?.params.alpha as number | undefined) ?? 1;
}

export function resolveNucleotideAppearance(
  document: MVSData,
  sourceFor: (node: Node, index: number) => Structure | undefined
): MVSData {
  const result = structuredClone(document);
  const roots = result.kind === 'multiple' ? result.snapshots.map((s) => s.root) : [result.root];
  for (const [index, typedRoot] of roots.entries()) {
    const root = typedRoot as Node;
    const profile = root.custom?.dnaforge_render_profile as
      | { version: number; nucleotideAppearance?: string; atomicColors: { carbonColor: string } }
      | undefined;
    if (
      !profile ||
      !['linked-residue-v1', 'linked-residue-v2'].includes(profile.nucleotideAppearance ?? '')
    )
      continue;
    const foregroundTrace = profile?.nucleotideAppearance === 'linked-residue-v2';
    const visit = (node: Node): void => {
      if (node.kind !== 'structure') {
        for (const child of node.children ?? []) visit(child);
        return;
      }
      const components = (node.children ?? []).filter((c) => c.kind === 'component');
      const owners = components.flatMap((component) => {
        const parts = (component.children ?? []).filter(
          (r) => r.custom?.dnaforge_nucleotide_generated
        );
        const atom = component.children?.find(
          (r) => r.params?.type === 'ball_and_stick' && !r.custom?.dnaforge_nucleotide_generated
        );
        return parts.length && atom ? [{ component, atom, parts }] : [];
      });
      if (!owners.length) return;
      const source = sourceFor(node, index);
      if (!source)
        throw Object.assign(
          new Error(
            'Nucleotide appearance requires this structure’s loaded coordinate source before authoring detail.'
          ),
          { code: 'MVS_NUCLEOTIDE_APPEARANCE_SOURCE_REQUIRED' }
        );
      const { select } = molecularSceneSelections(source);
      const traces = components.flatMap((component) =>
        (component.children ?? [])
          .filter(
            (r) =>
              ['cartoon', 'backbone'].includes(String(r.params?.type)) &&
              !r.custom?.dnaforge_nucleotide_generated &&
              molecularRepresentationVisible(r)
          )
          .map((rep) => ({
            rep,
            component,
            scope: select(component.params?.selector ?? 'all'),
            foreground: new Set<string>(),
            keys: residues(select(component.params?.selector ?? 'all')),
            alpha: alpha(rep),
          }))
      );
      for (const trace of traces)
        trace.rep.children = trace.rep.children?.filter(
          (c) => !c.custom?.dnaforge_nucleotide_appearance_color
        );
      const namedRegions = traces.flatMap((trace) =>
        (trace.rep.children ?? [])
          .filter(
            (c) =>
              c.kind === 'color' &&
              typeof c.custom?.dnaforge_legend_label === 'string' &&
              c.custom?.dnaforge_legend_generated !== true
          )
          .map((color) => ({
            color,
            keys: residues(select(color.params?.selector ?? 'all', trace.scope)),
          }))
      );
      const additions: Node[] = [];
      for (const { component, atom, parts } of owners) {
        const selected = select(component.params?.selector ?? 'all');
        const ownerKeys = residues(selected);
        const junctions = component.custom?.dnaforge_nucleotide_junction_atoms;
        if (Array.isArray(junctions) && junctions.length)
          for (const residue of residues(select(junctions))) ownerKeys.delete(residue);
        if (profile.version >= 12 && ownerKeys.size) {
          const native = atom.custom?.molstar_representation_params as
            | Record<string, unknown>
            | undefined;
          const kept = Array.isArray(native?.dnaforgeNucleotideKeepAtoms)
            ? native.dnaforgeNucleotideKeepAtoms
            : [];
          const required = kept.length ? select(kept, selected) : undefined;
          const needsBackbone = required?.units.some(
            (unit) =>
              Unit.isAtomic(unit) &&
              Array.from(unit.elements).some((index) => {
                const h = unit.model.atomicHierarchy;
                if (!isNucleic(h.derived.residue.moleculeType[unit.residueIndex[index]]))
                  return false;
                const name = h.atoms.label_atom_id.value(index);
                return NucleicBackboneAtoms.has(name) || name.includes("'") || name.includes('*');
              })
          );
          const full = native?.dnaforgeNucleotideAtomicMode === 'full' || needsBackbone;
          atom.custom = {
            ...atom.custom,
            molstar_representation_params: {
              ...native,
              dnaforgeNucleotideAtomicMode: full ? 'full' : 'base-only',
              dnaforgeNucleotideKeepAtoms: [],
              includeParent: false,
            },
          };
          for (let i = parts.length - 1; i >= 0; i--) {
            const params = parts[i].custom?.molstar_representation_params as
              | { visuals?: string[]; dnaforgeNucleotideExclude?: unknown[] }
              | undefined;
            if (!params?.visuals?.includes('dnaforge-nucleotide-connector')) continue;
            if (full) parts.splice(i, 1);
            else params.dnaforgeNucleotideExclude = [];
          }
        }
        if (foregroundTrace) {
          for (const color of atom.children?.filter((c) => c.kind === 'color') ?? []) {
            if (color.custom?.dnaforge_legend_generated !== true) continue;
            if (molecularColorIsElementPalette(color, atom)) continue;
            const keys = residues(select(color.params?.selector ?? 'all', selected));
            if (!keys.size) continue;
            const candidates = namedRegions
              .filter((r) => [...keys].every((k) => r.keys.has(k)))
              .sort((a, b) => a.keys.size - b.keys.size);
            const smallest = candidates.filter((r) => r.keys.size === candidates[0]?.keys.size);
            const identities = new Set(smallest.map((r) => r.color.custom!.dnaforge_legend_label));
            if (identities.size !== 1) continue;
            const owner = smallest[0].color;
            color.params = { ...color.params, color: owner.params?.color };
            color.custom = {
              ...color.custom,
              dnaforge_legend_label: owner.custom!.dnaforge_legend_label,
              dnaforge_legend_generated: false,
            };
            const theme = color.custom.molstar_color_theme_params as
              | { carbonColor?: { name?: string; params?: { value?: number } } }
              | undefined;
            if (theme?.carbonColor?.name === 'uniform')
              theme.carbonColor.params = {
                ...theme.carbonColor.params,
                value: parseInt(String(owner.params?.color).slice(1), 16),
              };
          }
        }
        if (foregroundTrace) {
          const identityLayers = (atom.children ?? []).filter(
            (c) => c.kind === 'color' && !molecularColorIsElementPalette(c, atom)
          );
          const labels = new Set(identityLayers.map((c) => c.custom?.dnaforge_legend_label));
          if (
            labels.size === 1 &&
            identityLayers.every((c) => c.custom?.dnaforge_legend_generated === false)
          ) {
            const label = String(identityLayers[0].custom!.dnaforge_legend_label);
            const color = String(identityLayers[0].params?.color);
            const group = {
              ...(atom.custom?.dnaforge_display_group as Record<string, unknown>),
              label,
              color,
              id: `${label}\u0000${parseInt(color.slice(1), 16)}`,
            };
            atom.custom = { ...atom.custom, dnaforge_display_group: group };
            for (const part of parts)
              part.custom = {
                ...part.custom,
                dnaforge_display_group: { ...group, supplement: true },
              };
          }
        }
        const layers = nucleotideGroupColors(atom, profile.atomicColors.carbonColor).map(
          (color) => ({
            color,
            keys: intersection(
              ownerKeys,
              residues(select(color.params?.selector ?? 'all', selected), true)
            ),
          })
        );
        const projected = (scope: ReadonlySet<string>) =>
          layers.flatMap((layer) => {
            const keys = intersection(scope, layer.keys);
            return keys.size
              ? [
                  {
                    ...structuredClone(layer.color),
                    params: {
                      ...layer.color.params,
                      selector: molecularAtomSelector(subset(source, keys), source),
                    },
                  },
                ]
              : [];
          });
        const opacity = new Map([...ownerKeys].map((k) => [k, alpha(atom)]));
        for (const trace of traces) {
          const overlap = intersection(ownerKeys, trace.keys);
          if (!overlap.size) continue;
          for (const k of overlap)
            opacity.set(k, foregroundTrace ? Math.max(opacity.get(k)!, trace.alpha) : trace.alpha);
          trace.rep.children = [
            ...(trace.rep.children ?? []),
            ...projected(overlap).map((color) => ({
              ...color,
              custom: { ...color.custom, dnaforge_nucleotide_appearance_color: true },
            })),
          ];
          if (foregroundTrace && alpha(atom) > trace.alpha) {
            for (const k of overlap) trace.foreground.add(k);
            const rep = structuredClone(trace.rep);
            rep.children = [
              ...(rep.children ?? []).filter((c) => c.kind !== 'color' && c.kind !== 'opacity'),
              ...projected(overlap),
              { kind: 'opacity', params: { opacity: alpha(atom) } },
            ];
            rep.custom = {
              ...rep.custom,
              dnaforge_nucleotide_appearance_trace: true,
              dnaforge_display_group: {
                ...(atom.custom?.dnaforge_display_group as Record<string, unknown>),
                supplement: true,
              },
              molstar_representation_params: {
                ...(rep.custom?.molstar_representation_params as Record<string, unknown>),
                alpha: alpha(atom),
                ...(rep.params?.type === 'cartoon'
                  ? { visuals: ['polymer-trace', 'polymer-gap'] }
                  : {}),
              },
            };
            additions.push({
              kind: 'component',
              params: { selector: molecularAtomSelector(subset(source, overlap), source) },
              custom: { dnaforge_nucleotide_appearance_part: true },
              children: [rep],
            });
          }
        }
        const partitions = new Map<number, Set<string>>();
        for (const [k, value] of opacity) {
          const keys = partitions.get(value) ?? new Set<string>();
          keys.add(k);
          partitions.set(value, keys);
        }
        component.children = component.children?.filter(
          (r) => !r.custom?.dnaforge_nucleotide_generated
        );
        for (const part of parts) {
          const visual = (
            part.custom?.molstar_representation_params as { visuals?: string[] } | undefined
          )?.visuals;
          const plane = visual?.includes(NUCLEOTIDE_BASE_PLANE_VISUAL);
          for (const [traceAlpha, keys] of partitions) {
            const shape = structuredClone(part);
            const partAlpha = plane ? Math.min(alpha(part), traceAlpha) : traceAlpha;
            const colors =
              plane && atom.custom?.dnaforge_nucleotide_base_color_override === true
                ? (shape.children?.filter((c) => c.kind === 'color') ?? [])
                : projected(keys);
            shape.children = [...colors, { kind: 'opacity', params: { opacity: partAlpha } }];
            shape.custom = {
              ...shape.custom,
              molstar_representation_params: {
                ...(shape.custom?.molstar_representation_params as
                  | Record<string, unknown>
                  | undefined),
                alpha: partAlpha,
              },
            };
            additions.push({
              kind: 'component',
              params: { selector: molecularAtomSelector(subset(source, keys), source) },
              custom: { dnaforge_nucleotide_appearance_part: true },
              children: [shape],
            });
          }
        }
      }
      for (const trace of traces) {
        if (!trace.foreground.size) continue;
        const context = withoutResidues(trace.scope, trace.foreground);
        if (context.elementCount)
          additions.push({
            kind: 'component',
            params: { selector: molecularAtomSelector(context, source) },
            custom: { dnaforge_nucleotide_appearance_part: true },
            children: [structuredClone(trace.rep)],
          });
        trace.rep.custom = {
          ...trace.rep.custom,
          is_hidden: true,
          dnaforge_nucleotide_appearance_context: true,
        };
      }
      node.children = [...(node.children ?? []), ...additions];
    };
    visit(root);
  }
  return result;
}
