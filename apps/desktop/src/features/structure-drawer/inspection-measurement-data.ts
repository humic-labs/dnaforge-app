import {
  prepareMolecularDataPublication,
  molecularDataLayerSchema,
  type MolecularDataset,
  type MolecularDataLayer,
} from '../../shared/molecular-data';
import {
  residueMeasurementSchema,
  type ResidueMeasurement,
} from '../page/public/embeds/structure3d/residueMeasurement';
import { structureResiduesForLinkedResidueIndex } from './utils/residue-target-mapping';
import type { StructureLinkEntry } from './state/use-structure-link-registry';

export async function prepareInspectionMeasurementData(
  input: ResidueMeasurement,
  link: Pick<StructureLinkEntry, 'residueTarget' | 'residueTargets'>,
  coordinateSha256: string
) {
  const measurement = residueMeasurementSchema.parse(input);
  const scopes = link.residueTargets ?? (link.residueTarget ? [link.residueTarget] : []);
  if (
    !scopes.length ||
    scopes.some(
      (target) => target.residues === undefined && target.residueMappingKind !== 'identity'
    )
  )
    throw new Error('This protein has no verified residue mapping.');
  const targets = measurement.values.flatMap((point, row) => {
    const selectors = structureResiduesForLinkedResidueIndex(link, point.residue - 1).map(
      (residue) => ({
        ...(residue.labelAsymId
          ? { label_asym_id: residue.labelAsymId }
          : { auth_asym_id: residue.authAsymId ?? residue.baseChain ?? residue.chain }),
        ...(residue.labelSeqId !== undefined
          ? { label_seq_id: residue.labelSeqId }
          : { auth_seq_id: residue.position }),
        ...(residue.entityId ? { label_entity_id: residue.entityId } : {}),
        ...(residue.operator ? { instance_id: residue.operator } : {}),
      })
    );
    return selectors.length ? [{ row, selector: selectors }] : [];
  });
  const publication = {
    id: `protein-measurement:${measurement.id}`,
    name: measurement.name,
    records: measurement.values.map(({ residue, value }) => ({ residue, value })),
    source: {
      label: measurement.source.label,
      ...(measurement.source.correspondence
        ? { correspondence: measurement.source.correspondence }
        : {}),
      metadata: { residueMeasurement: measurement },
    },
    mapping: { coordinateSha256, targets },
  };
  const prepared = await prepareMolecularDataPublication(publication);
  const layer = molecularDataLayerSchema.parse({
    id: measurement.id,
    name: measurement.name,
    datasetId: prepared.dataset.id,
    dataRevision: prepared.dataset.revision,
    mappingRevision: prepared.mapping.revision,
    column: 'value',
    units: measurement.units,
    style: { kind: 'continuous', ...measurement.scale, quantization: 256 },
    backgroundSelector: scopes.map((scope) => ({
      ...(scope.labelAsymId
        ? { label_asym_id: scope.labelAsymId }
        : { auth_asym_id: scope.authAsymId ?? scope.baseChain ?? scope.chain }),
      ...(scope.entityId ? { label_entity_id: scope.entityId } : {}),
      ...(scope.operator ? { instance_id: scope.operator } : {}),
    })),
  });
  return { publication, ...prepared, layer };
}

export function inspectionMeasurementFromDataset(
  dataset: MolecularDataset
): ResidueMeasurement | undefined {
  const original = dataset.source.metadata?.residueMeasurement;
  if (original === undefined) return undefined;
  const measurement = residueMeasurementSchema.parse(original);
  if (
    dataset.id !== `protein-measurement:${measurement.id}` ||
    dataset.records.length !== measurement.values.length ||
    measurement.values.some(
      (point, row) =>
        point.residue !== dataset.records[row].residue || point.value !== dataset.records[row].value
    )
  )
    throw new Error('The retained protein measurement differs from its published values.');
  return measurement;
}

export function inspectionMeasurementForLayer(
  dataset: MolecularDataset,
  layer: MolecularDataLayer
): ResidueMeasurement | undefined {
  const original = inspectionMeasurementFromDataset(dataset);
  if (
    !original ||
    layer.id !== original.id ||
    layer.column !== 'value' ||
    layer.filter ||
    layer.style.kind !== 'continuous'
  )
    return undefined;
  const { domain, colors, missingColor, transform } = layer.style;
  const projected = residueMeasurementSchema.safeParse({
    ...original,
    name: layer.name,
    units: layer.units ?? original.units,
    scale: { domain, colors, missingColor, transform },
  });
  return projected.success ? projected.data : undefined;
}
