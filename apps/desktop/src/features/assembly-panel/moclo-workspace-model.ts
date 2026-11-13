import type { AssemblyColorSchemeId } from '../design/public/colors';
import { getFragmentHexForRegion } from '../design/public/colors';
import { isRestrictionDigestRegion } from '../design/public/restriction-digest';
import type { DesignRegion, SequenceDesign } from '../design/public/types';
import type { GoldenGateAssemblySchema } from '../design/public/golden-gate-schema';
import { schemaSlotForRegion } from '../design/public/assembly-slots';

export type MocloComponentRoute = 'PCR' | 'Restriction digest' | 'Empty';

export interface MocloWorkspacePart {
  regionId: string;
  schemaSlotId?: string;
  index: number;
  name: string;
  role: string;
  length: number;
  route: MocloComponentRoute;
  entryOverhang: string | null;
  exitOverhang: string | null;
  color: string;
  fixedByDigest: boolean;
  input: { kind: 'kit-part' } | { kind: 'stage-output'; sourceStageId: string };
}

export interface MocloWorkspaceModel {
  enzyme: NonNullable<SequenceDesign['goldenGateConfig']>['enzyme'];
  parts: MocloWorkspacePart[];
  isClosed: boolean;
  schema: GoldenGateAssemblySchema;
  schemaIsPersisted: boolean;
  designVersion: number;
  topology: SequenceDesign['topology'];
}

function canonicalRole(region: DesignRegion): string {
  if (region.ggType === 'backbone') return 'Destination vector';

  const searchable = [
    region.sourceSequenceName,
    ...region.annotations.flatMap((annotation) => [annotation.type, annotation.name]),
  ]
    .join(' ')
    .toLowerCase();

  if (/promoter|j23106/.test(searchable)) return 'Promoter';
  if (/ribosome.?binding|\brbs\b|b0034/.test(searchable)) return 'RBS';
  if (/\bcds\b|coding|mr?fp|e1010/.test(searchable)) return 'CDS';
  if (/terminator|b0015/.test(searchable)) return 'Terminator';
  return 'Component';
}

function junctionOverhang(design: SequenceDesign, junctionIndex: number): string | null {
  return (
    design.goldenGateJunctions?.find((junction) => junction.junctionIndex === junctionIndex)
      ?.overhang ?? null
  );
}

export function createMocloWorkspaceModel(
  design: SequenceDesign,
  colorScheme: AssemblyColorSchemeId
): MocloWorkspaceModel | null {
  if (design.assemblyMethod !== 'goldengate' || !design.goldenGateConfig) return null;

  const partCount = design.regions.length;
  const parts = design.regions.map((region, index): MocloWorkspacePart => {
    const previousJunction = (index - 1 + partCount) % partCount;
    const fixedByDigest = isRestrictionDigestRegion(region);
    const schemaSlotId = schemaSlotForRegion(design, region)?.id;
    const stageInput = design.mocloFactory?.stageInputs.find(
      (input) => input.slotId === schemaSlotId
    );
    return {
      regionId: region.id,
      schemaSlotId,
      index,
      name: region.sourceSequenceName || `Part ${index + 1}`,
      role: canonicalRole(region),
      length: region.sequence.length,
      route: region.isPlaceholder ? 'Empty' : fixedByDigest ? 'Restriction digest' : 'PCR',
      entryOverhang:
        region.rdOverhangs?.upstream ??
        (partCount > 0 ? junctionOverhang(design, previousJunction) : null),
      exitOverhang:
        region.rdOverhangs?.downstream ?? (partCount > 0 ? junctionOverhang(design, index) : null),
      color: getFragmentHexForRegion(region, index, colorScheme),
      fixedByDigest,
      input: stageInput
        ? { kind: 'stage-output', sourceStageId: stageInput.sourceStageId }
        : { kind: 'kit-part' },
    };
  });

  const isClosed =
    design.topology === 'circular' &&
    parts.length > 0 &&
    parts.every((part, index) => {
      const next = parts[(index + 1) % parts.length];
      return (
        part.route !== 'Empty' &&
        part.exitOverhang !== null &&
        part.exitOverhang === next.entryOverhang
      );
    });

  return {
    enzyme: design.goldenGateConfig.enzyme,
    parts,
    isClosed,
    schema: design.goldenGateSchema ?? {
      id: `schema:${design.id}`,
      name: `${design.name} schema`,
      revision: 1,
      origin: { type: 'custom' },
      enzyme: design.goldenGateConfig.enzyme,
      slots: parts.map((part) => ({
        id: part.regionId,
        label: part.role,
        outgoingOverhang: part.exitOverhang,
        preferredRoles: part.role === 'Component' ? [] : [{ label: part.role }],
      })),
    },
    schemaIsPersisted: design.goldenGateSchema !== undefined,
    designVersion: design.version,
    topology: design.topology,
  };
}
