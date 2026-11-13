import type { DesignRegion, SequenceDesign } from './types';
import { emptyDesignRegion } from './assembly-slots';
import type {
  GoldenGateAssemblySchema,
  GoldenGateSchemaIssue,
  GoldenGateSchemaOrigin,
} from './golden-gate-schema';
import { validateGoldenGateSchema } from './golden-gate-schema';

export type GoldenGateSchemaCommandRejection =
  | {
      status: 'rejected';
      code: 'stale-version' | 'not-golden-gate' | 'confirmation-required';
      message: string;
    }
  | {
      status: 'rejected';
      code: 'invalid-schema';
      message: string;
      issues: GoldenGateSchemaIssue[];
    };

export type GoldenGateSchemaCommandResult =
  | { status: 'applied'; nextDesign: SequenceDesign }
  | { status: 'no-op'; currentDesign: SequenceDesign }
  | GoldenGateSchemaCommandRejection;

export interface GoldenGateSchemaCommandInput {
  design: SequenceDesign;
  schema?: GoldenGateAssemblySchema;
  expectedVersion: number;
  now?: Date;
  options?: GoldenGateSchemaChangeOptions;
}

export interface GoldenGateSchemaChangeOptions {
  confirmedReset?: boolean;
  kit?: SequenceDesign['pendingGoldenGateKit'];
}

function originSignature(origin: GoldenGateSchemaOrigin): string {
  switch (origin.type) {
    case 'custom':
      return 'custom';
    case 'kit':
      return `kit:${origin.kitId}:${origin.kitName}:${origin.schemaId ?? ''}`;
    case 'imported':
      return `imported:${origin.sourceLabel}`;
  }
}

function schemaSignature(schema: GoldenGateAssemblySchema | undefined): string | null {
  if (!schema) return null;
  return JSON.stringify([
    schema.id,
    schema.name,
    schema.revision,
    originSignature(schema.origin),
    schema.enzyme,
    schema.slots.map((slot) => [
      slot.id,
      slot.label,
      slot.outgoingOverhang,
      slot.preferredRoles.map((role) => [role.id ?? null, role.label]),
    ]),
  ]);
}

function placeholderRegionId(
  schema: GoldenGateAssemblySchema,
  slotId: string,
  existingIds: Set<string>
): string {
  const base = `schema-slot-${schema.id}-${slotId}`;
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

function emptyRegionForSlot(
  schema: GoldenGateAssemblySchema,
  slotIndex: number,
  existingIds: Set<string>
): DesignRegion {
  const slot = schema.slots[slotIndex];
  return {
    ...emptyDesignRegion(`Empty ${slot.label || `slot ${slotIndex + 1}`}`),
    id: placeholderRegionId(schema, slot.id, existingIds),
    schemaSlotId: slot.id,
  };
}

export function selectedGoldenGateKit(
  design: SequenceDesign
): SequenceDesign['pendingGoldenGateKit'] {
  const origin = design.goldenGateSchema?.origin;
  return origin?.type === 'kit'
    ? { id: origin.kitId, name: origin.kitName }
    : design.pendingGoldenGateKit;
}

export function applyGoldenGateSchemaCommand({
  design,
  schema,
  expectedVersion,
  now = new Date(),
  options = {},
}: GoldenGateSchemaCommandInput): GoldenGateSchemaCommandResult {
  if (design.version !== expectedVersion) {
    return {
      status: 'rejected',
      code: 'stale-version',
      message: `Expected design version ${expectedVersion}, but found ${design.version}.`,
    };
  }
  if (design.assemblyMethod !== 'goldengate') {
    return {
      status: 'rejected',
      code: 'not-golden-gate',
      message: 'Golden Gate schemas can only be applied to Golden Gate assemblies.',
    };
  }

  const validation = schema
    ? validateGoldenGateSchema(schema, design.topology)
    : { ok: true as const };
  if (!validation.ok) {
    return {
      status: 'rejected',
      code: 'invalid-schema',
      message: 'Golden Gate schema is invalid.',
      issues: validation.issues,
    };
  }

  if (
    schemaSignature(design.goldenGateSchema) === schemaSignature(schema) &&
    (schema
      ? design.goldenGateConfig?.enzyme === schema.enzyme &&
        design.regions.length === schema.slots.length
      : design.pendingGoldenGateKit?.id === options.kit?.id && !design.mocloFactory)
  ) {
    return { status: 'no-op', currentDesign: design };
  }

  const containsWork =
    design.regions.some((region) => !region.isPlaceholder || region.sequence.length > 0) ||
    design.spacers.length > 0 ||
    design.designPrimers.length > 0 ||
    Boolean(
      design.assemblyResult ||
      design.mocloFactory ||
      design.assemblyWorkbench?.primerEditIntents?.length
    );
  if (containsWork && !options.confirmedReset) {
    return {
      status: 'rejected',
      code: 'confirmation-required',
      message:
        'Changing the kit or schema clears this assembly’s parts, spacers and primers. This starts a new draft and cannot be undone.',
    };
  }

  const existingIds = new Set<string>();
  return {
    status: 'applied',
    nextDesign: {
      ...design,
      goldenGateSchema: schema ? structuredClone(schema) : undefined,
      pendingGoldenGateKit: schema ? undefined : options.kit ? { ...options.kit } : undefined,
      goldenGateConfig: { enzyme: schema?.enzyme ?? design.goldenGateConfig?.enzyme ?? 'BsaI' },
      regions: schema
        ? schema.slots.map((_, index) => emptyRegionForSlot(schema, index, existingIds))
        : [],
      spacers: [],
      mocloFactory: undefined,
      assemblyMethodDrafts: undefined,
      backboneSequenceId: null,
      proposedPlans: [],
      version: design.version + 1,
      updatedAt: now,
      assemblyState: 'drafting',
      status: 'draft',
      assemblyResult: undefined,
      homologyRegions: [],
      goldenGateJunctions: [],
      designPrimers: [],
      validationErrors: [],
      selectedJunctionIndex: null,
      assemblyWorkbench: undefined,
      activeAcceptedAssemblyVersionId: null,
      scrollToPosition: null,
      highlightRange: null,
      activeCutSiteIndex: null,
      hoveredCutSiteRegionId: null,
    },
  };
}
