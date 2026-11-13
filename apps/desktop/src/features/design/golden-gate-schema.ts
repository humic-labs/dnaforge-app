import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { DNA_ALPHABET } from '@waypoint/sequence-utils';
import { ENZYME_SPECS } from './types';
import type { GoldenGateAssemblySchema, GoldenGateRoleEvidence, GoldenGateRoleTerm } from './types';

export type {
  GoldenGateAssemblySchema,
  GoldenGateRoleEvidence,
  GoldenGateRoleTerm,
  GoldenGateSchemaOrigin,
  GoldenGateSchemaSlot,
} from './types';

export function isGoldenGateSchemaStructureLocked(
  schema: GoldenGateAssemblySchema | undefined
): boolean {
  return schema !== undefined && schema.origin.type !== 'custom';
}

export interface GoldenGatePartCandidate {
  id: string;
  name: string;
  route: 'pcr' | 'restriction-digest';
  upstreamOverhang: string | null;
  downstreamOverhang: string | null;
  roleEvidence: GoldenGateRoleEvidence[];
  kit: { id: string; name: string } | null;
}

export type GoldenGatePhysicalCompatibility =
  | { type: 'exact' }
  | {
      type: 'pcr-adaptable';
      requiredUpstreamOverhang: string | null;
      requiredDownstreamOverhang: string | null;
    }
  | {
      type: 'incompatible';
      mismatches: Array<{
        end: 'upstream' | 'downstream';
        expected: string;
        actual: string | null;
      }>;
    };

export type GoldenGateRoleCompatibility =
  | { type: 'unconstrained' }
  | {
      type: 'match';
      matchedPreferredRole: GoldenGateRoleTerm;
      matchedEvidence: GoldenGateRoleEvidence;
    }
  | { type: 'unknown'; preferredRoles: GoldenGateRoleTerm[] }
  | {
      type: 'mismatch';
      preferredRoles: GoldenGateRoleTerm[];
      observedRoles: GoldenGateRoleEvidence[];
    };

export interface GoldenGateCandidateCompatibility {
  physical: GoldenGatePhysicalCompatibility;
  role: GoldenGateRoleCompatibility;
}

export type GoldenGateSchemaIssueCode =
  | 'schema-id-required'
  | 'schema-name-required'
  | 'revision-invalid'
  | 'slot-required'
  | 'slot-id-required'
  | 'slot-label-required'
  | 'duplicate-slot-id'
  | 'overhang-length'
  | 'overhang-alphabet'
  | 'linear-terminal-junction-forbidden'
  | 'role-label-required';

export interface GoldenGateSchemaIssue {
  code: GoldenGateSchemaIssueCode;
  message: UserMessage;
  slotId?: string;
}

export type GoldenGateSchemaValidation =
  | { ok: true }
  | { ok: false; issues: GoldenGateSchemaIssue[] };

export function deriveGoldenGateSlotEnds(
  schema: GoldenGateAssemblySchema,
  slotIndex: number,
  topology: 'linear' | 'circular'
): { incomingOverhang: string | null; outgoingOverhang: string | null } {
  const slot = schema.slots[slotIndex];
  if (!slot) {
    throw new RangeError(`Golden Gate schema slot ${slotIndex} does not exist.`);
  }

  const previousIndex = slotIndex - 1;
  const incomingOverhang =
    previousIndex >= 0
      ? schema.slots[previousIndex].outgoingOverhang
      : topology === 'circular'
        ? (schema.slots[schema.slots.length - 1]?.outgoingOverhang ?? null)
        : null;

  return {
    incomingOverhang,
    outgoingOverhang: slot.outgoingOverhang,
  };
}

export function validateGoldenGateSchema(
  schema: GoldenGateAssemblySchema,
  topology: 'linear' | 'circular'
): GoldenGateSchemaValidation {
  const issues: GoldenGateSchemaIssue[] = [];
  const slotIds = new Set<string>();
  const expectedOverhangLength = ENZYME_SPECS[schema.enzyme].overhangLength;

  if (schema.id.trim().length === 0) {
    issues.push({ code: 'schema-id-required', message: userMessage('assembly.schemaId') });
  }
  if (schema.name.trim().length === 0) {
    issues.push({ code: 'schema-name-required', message: userMessage('assembly.schemaName') });
  }
  if (!Number.isSafeInteger(schema.revision) || schema.revision < 1) {
    issues.push({
      code: 'revision-invalid',
      message: userMessage('assembly.schemaRevision'),
    });
  }
  if (schema.slots.length === 0) {
    issues.push({ code: 'slot-required', message: userMessage('assembly.schemaSlots') });
  }

  schema.slots.forEach((slot, index) => {
    const slotId = slot.id.trim();
    if (slotId.length === 0) {
      issues.push({
        code: 'slot-id-required',
        message: userMessageWithValues('assembly.slotId', { index: userMessageValue(index + 1) }),
        slotId: slot.id,
      });
    } else if (slotIds.has(slotId)) {
      issues.push({
        code: 'duplicate-slot-id',
        message: userMessageWithValues('assembly.slotDuplicate', {
          slot: userMessageValue(slotId),
        }),
        slotId,
      });
    }
    slotIds.add(slotId);

    if (slot.label.trim().length === 0) {
      issues.push({
        code: 'slot-label-required',
        message: userMessageWithValues('assembly.slotLabel', {
          index: userMessageValue(index + 1),
        }),
        slotId: slot.id,
      });
    }

    for (const role of slot.preferredRoles) {
      if (role.label.trim().length === 0) {
        issues.push({
          code: 'role-label-required',
          message: userMessageWithValues('assembly.roleEmpty', {
            slot: userMessageValue(slot.label || 'Unnamed position'),
          }),
          slotId: slot.id,
        });
      }
    }

    const overhang = slot.outgoingOverhang;
    const isTerminalLinearSlot = topology === 'linear' && index === schema.slots.length - 1;
    if (isTerminalLinearSlot && overhang !== null) {
      issues.push({
        code: 'linear-terminal-junction-forbidden',
        message: userMessage('assembly.linearJunction'),
        slotId: slot.id,
      });
    }
    if (overhang === null) return;

    if (overhang.length !== expectedOverhangLength) {
      issues.push({
        code: 'overhang-length',
        message: userMessageWithValues('assembly.overhangLength', {
          enzyme: userMessageValue(schema.enzyme),
          length: userMessageValue(expectedOverhangLength),
        }),
        slotId: slot.id,
      });
    }
    if ([...overhang.toUpperCase()].some((base) => !DNA_ALPHABET.includes(base))) {
      issues.push({
        code: 'overhang-alphabet',
        message: userMessageWithValues('assembly.overhangAlphabet', {
          overhang: userMessageValue(overhang),
        }),
        slotId: slot.id,
      });
    }
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function normalizedRoleValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function rolesMatch(preferred: GoldenGateRoleTerm, observed: GoldenGateRoleTerm): boolean {
  if (
    preferred.id &&
    observed.id &&
    normalizedRoleValue(preferred.id) === normalizedRoleValue(observed.id)
  ) {
    return true;
  }
  return normalizedRoleValue(preferred.label) === normalizedRoleValue(observed.label);
}

function classifyRole(
  preferredRoles: GoldenGateRoleTerm[],
  observedRoles: GoldenGateRoleEvidence[]
): GoldenGateRoleCompatibility {
  if (preferredRoles.length === 0) return { type: 'unconstrained' };
  if (observedRoles.length === 0) return { type: 'unknown', preferredRoles };

  for (const preferredRole of preferredRoles) {
    const matchedEvidence = observedRoles.find((observedRole) =>
      rolesMatch(preferredRole, observedRole)
    );
    if (matchedEvidence) {
      return { type: 'match', matchedPreferredRole: preferredRole, matchedEvidence };
    }
  }

  return { type: 'mismatch', preferredRoles, observedRoles };
}

export function classifyGoldenGateCandidate(
  schema: GoldenGateAssemblySchema,
  slotIndex: number,
  topology: 'linear' | 'circular',
  candidate: GoldenGatePartCandidate
): GoldenGateCandidateCompatibility {
  const { incomingOverhang, outgoingOverhang } = deriveGoldenGateSlotEnds(
    schema,
    slotIndex,
    topology
  );
  const slot = schema.slots[slotIndex];

  if (candidate.route === 'pcr') {
    return {
      physical: {
        type: 'pcr-adaptable',
        requiredUpstreamOverhang: incomingOverhang,
        requiredDownstreamOverhang: outgoingOverhang,
      },
      role: classifyRole(slot.preferredRoles, candidate.roleEvidence),
    };
  }

  const mismatches: Array<{
    end: 'upstream' | 'downstream';
    expected: string;
    actual: string | null;
  }> = [];
  if (incomingOverhang !== null && candidate.upstreamOverhang?.toUpperCase() !== incomingOverhang) {
    mismatches.push({
      end: 'upstream',
      expected: incomingOverhang,
      actual: candidate.upstreamOverhang,
    });
  }
  if (
    outgoingOverhang !== null &&
    candidate.downstreamOverhang?.toUpperCase() !== outgoingOverhang
  ) {
    mismatches.push({
      end: 'downstream',
      expected: outgoingOverhang,
      actual: candidate.downstreamOverhang,
    });
  }

  return {
    physical: mismatches.length === 0 ? { type: 'exact' } : { type: 'incompatible', mismatches },
    role: classifyRole(slot.preferredRoles, candidate.roleEvidence),
  };
}
