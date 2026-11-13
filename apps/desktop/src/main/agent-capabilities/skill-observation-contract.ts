import type { OptionalTelemetryOrigin } from '../analytics-outbox';
import {
  skillOperationProperties,
  type SkillAction,
  type SkillObservationContext,
  type SkillOperationProperties,
} from '../../shared/skill-operation-telemetry';

export interface SkillMutationObservationContext {
  operationId: string;
  eventId: string;
  returnEventId: string;
  origin: OptionalTelemetryOrigin;
}
export interface SkillMutationFacts extends SkillObservationContext {
  action: SkillAction;
  atMs: number;

  binding: {
    kind: 'skill' | 'policy' | 'skill_absent' | 'policy_absent';
    id: string;
    updatedAt?: number;
  };
}
export interface CommittedSkillObservation {
  schemaVersion: 1;
  operationId: string;
  eventId: string;
  origin: OptionalTelemetryOrigin;
  atMs: number;
  properties: SkillOperationProperties;
  binding: SkillMutationFacts['binding'];
}
export type SkillReceiptPublisher = (
  readCommitted: () => CommittedSkillObservation | null
) => boolean;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ORIGIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function prepareSkillObservation(
  context: SkillMutationObservationContext | null | undefined,
  facts: SkillMutationFacts
): CommittedSkillObservation | null {
  try {
    if (
      !context ||
      !UUID.test(context.operationId) ||
      !UUID.test(context.eventId) ||
      !Number.isFinite(facts.atMs) ||
      facts.atMs < 0
    )
      return null;
    return decodeSkillObservation({
      schemaVersion: 1,
      operationId: context.operationId,
      eventId: context.eventId,
      origin: { ...context.origin },
      atMs: facts.atMs,
      binding: { ...facts.binding },
      properties: skillOperationProperties(
        context.operationId,
        facts.action,
        'mutation',
        'manifest_committed',
        { ...facts, authority: 'committed_domain_receipt', freshness: 'current_readback' },
        facts.atMs,
        'native_domain'
      ),
    });
  } catch {
    return null;
  }
}

export function decodeSkillObservation(value: unknown): CommittedSkillObservation | null {
  try {
    const input = object(value);
    const origin = object(input?.origin);
    const properties = object(input?.properties);
    const binding = object(input?.binding);
    if (
      !input ||
      input.schemaVersion !== 1 ||
      !origin ||
      !properties ||
      !binding ||
      typeof input.operationId !== 'string' ||
      !UUID.test(input.operationId) ||
      typeof input.eventId !== 'string' ||
      !UUID.test(input.eventId) ||
      typeof input.atMs !== 'number' ||
      !Number.isFinite(input.atMs) ||
      input.atMs < 0
    )
      return null;
    if (
      typeof origin.classification !== 'string' ||
      !['consentScope', 'contextId', 'processId'].every(
        (key) => typeof origin[key] === 'string' && ORIGIN_UUID.test(origin[key] as string)
      ) ||
      !['synthetic', 'private', 'unknown', 'eligible_release'].includes(
        String(origin.classification)
      )
    )
      return null;
    if (
      typeof binding.kind !== 'string' ||
      !['skill', 'policy', 'skill_absent', 'policy_absent'].includes(String(binding.kind)) ||
      typeof binding.id !== 'string' ||
      binding.id.length < 1 ||
      binding.id.length > 512 ||
      (binding.updatedAt !== undefined &&
        (typeof binding.updatedAt !== 'number' || !Number.isFinite(binding.updatedAt)))
    )
      return null;
    const normalized = skillOperationProperties(
      input.operationId,
      properties.skills_action as SkillAction,
      'mutation',
      'manifest_committed',
      {
        host: properties.skills_host as SkillObservationContext['host'],
        scope: properties.skills_scope as SkillObservationContext['scope'],
        source: properties.skills_source as SkillObservationContext['source'],
        installed: properties.skills_installed as SkillObservationContext['installed'],
        storedEnablement:
          properties.skills_stored_enablement as SkillObservationContext['storedEnablement'],
        effectiveEnablement:
          properties.skills_effective_enablement as SkillObservationContext['effectiveEnablement'],
        runtime: properties.skills_runtime_discovery as SkillObservationContext['runtime'],
        instruction: properties.skills_instruction_load as SkillObservationContext['instruction'],
        authority: 'committed_domain_receipt',
        freshness: 'current_readback',
      },
      input.atMs,
      'native_domain'
    );
    const canonical = (v: object) =>
      JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));
    if (canonical(normalized) !== canonical(properties)) return null;
    return {
      schemaVersion: 1,
      operationId: input.operationId,
      eventId: input.eventId,
      atMs: input.atMs,
      origin: {
        consentScope: origin.consentScope as string,
        contextId: origin.contextId as string,
        processId: origin.processId as string,
        classification: origin.classification as OptionalTelemetryOrigin['classification'],
      },
      properties: normalized,
      binding: {
        kind: binding.kind as SkillMutationFacts['binding']['kind'],
        id: binding.id,
        ...(typeof binding.updatedAt === 'number' ? { updatedAt: binding.updatedAt } : {}),
      },
    };
  } catch {
    return null;
  }
}
