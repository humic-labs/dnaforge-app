import type { MolecularComparison } from '../page/public/embeds/structure3d/molecularView';
import {
  measurementColor,
  residueMeasurementSchema,
  type ResidueMeasurement,
} from '../page/public/embeds/structure3d/residueMeasurement';
import { structureResiduesForLinkedResidueIndex } from './utils/residue-target-mapping';
import type { StructureLinkEntry } from './state/use-structure-link-registry';

type Node = { kind: string; ref?: string; params?: Record<string, unknown>; children?: Node[] };
const colorRef = 'dnaforge-analysis-color:';
export function compileMeasurementScene(
  scene: string,
  input: ResidueMeasurement,
  link: Pick<StructureLinkEntry, 'residueTarget' | 'residueTargets'>,
  comparison?: MolecularComparison
): { scene: string; mappedResidues: number[]; unmappedResidues: number[] } {
  const measurement = residueMeasurementSchema.parse(input);
  const targets = link.residueTargets ?? (link.residueTarget ? [link.residueTarget] : []);
  if (
    !targets.length ||
    targets.some(
      (target) => target.residues === undefined && target.residueMappingKind !== 'identity'
    )
  )
    throw new Error('This protein has no verified residue mapping.');
  const document = JSON.parse(scene) as { kind?: string; root: Node };
  if (document.kind === 'multiple' || document.root?.kind !== 'root')
    throw new Error(
      'Apply a measurement to a single scene. Select or extract the intended story step first.'
    );
  const structures: Node[] = [];
  const visit = (node: Node) => {
    if (node.kind === 'structure') structures.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(document.root);
  const comparisonModels =
    comparison &&
    structures.length === 2 &&
    structures.every((node) => node.params?.type === 'model') &&
    new Set(structures.map((node) => node.params?.model_index ?? 0)).size === 2 &&
    structures.every((node) => [0, 1].includes(Number(node.params?.model_index ?? 0))) &&
    targets.every((target) => ['R', 'V'].includes(target.labelAsymId ?? ''));
  if (structures.length !== 1 && !comparisonModels)
    throw new Error('Measurement mapping requires one coordinate model or assembly in the scene.');
  const baseSelector = targets.map((target) => ({
    ...(target.labelAsymId
      ? { label_asym_id: target.labelAsymId }
      : { auth_asym_id: target.authAsymId ?? target.baseChain ?? target.chain }),
    ...(target.entityId ? { label_entity_id: target.entityId } : {}),
    ...(target.operator ? { instance_id: target.operator } : {}),
  }));
  const grouped = new Map<string, Record<string, unknown>[]>();
  const mappedResidues: number[] = [],
    unmappedResidues: number[] = [];
  for (const point of measurement.values) {
    const locations = structureResiduesForLinkedResidueIndex(link, point.residue - 1);
    if (!locations.length) {
      unmappedResidues.push(point.residue);
      continue;
    }
    mappedResidues.push(point.residue);
    const color = measurementColor(measurement, point.value);
    const selectors = grouped.get(color) ?? [];
    for (const residue of locations)
      selectors.push({
        ...(residue.labelAsymId
          ? { label_asym_id: residue.labelAsymId }
          : { auth_asym_id: residue.authAsymId ?? residue.baseChain ?? residue.chain }),
        ...(residue.labelSeqId !== undefined
          ? { label_seq_id: residue.labelSeqId }
          : { auth_seq_id: residue.position }),
        ...(residue.entityId ? { label_entity_id: residue.entityId } : {}),
        ...(residue.operator ? { instance_id: residue.operator } : {}),
      });
    grouped.set(color, selectors);
  }
  if (!mappedResidues.length)
    throw new Error('None of the measurement residues map to this structure.');
  let count = 0;
  const recolor = (node: Node) => {
    if (node.kind === 'representation') {
      count++;
      node.children = [
        ...(node.children ?? []).filter((child) => !child.ref?.startsWith(colorRef)),
        {
          kind: 'color',
          ref: `${colorRef}${count}:missing`,
          params: { color: measurement.scale.missingColor, selector: baseSelector },
        },
        ...[...grouped].map(([color, selector], index) => ({
          kind: 'color',
          ref: `${colorRef}${count}:${index}`,
          params: { color, selector },
        })),
      ];
    } else for (const child of node.children ?? []) recolor(child);
  };
  for (const structure of structures) recolor(structure);
  if (!count) throw new Error('The scene has no visible molecular representation to color.');
  return { scene: JSON.stringify(document), mappedResidues, unmappedResidues };
}
