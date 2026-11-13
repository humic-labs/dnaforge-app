import { randomUUID } from 'node:crypto';
import {
  captureOptionalTelemetryOrigin,
  enqueueOptionalAnalyticsEvent,
  enqueueOptionalAnalyticsEventFromReceipt,
} from '../analytics';
import {
  SKILL_OPERATION_OBSERVED,
  SKILL_HOSTS,
  closedSkillValue,
  skillOperationProperties,
  type SkillAction,
  type SkillObservationContext,
  type SkillOperationProperties,
} from '../../shared/skill-operation-telemetry';
import type {
  CommittedSkillObservation,
  SkillMutationObservationContext,
} from './skill-observation-contract';

export function captureSkillObservation(): SkillMutationObservationContext | null {
  try {
    const origin = captureOptionalTelemetryOrigin();
    return origin
      ? { operationId: randomUUID(), eventId: randomUUID(), returnEventId: randomUUID(), origin }
      : null;
  } catch {
    return null;
  }
}

export function reportSkillOwnerReturn(
  observation: SkillMutationObservationContext | null,
  action: SkillAction,
  result: SkillOperationProperties['skills_result'],
  context: SkillObservationContext = {}
): void {
  if (!observation) return;
  try {
    const atMs = Date.now();
    enqueueOptionalAnalyticsEvent(observation.origin, {
      eventId: observation.returnEventId,
      eventName: SKILL_OPERATION_OBSERVED,
      payloadSchemaVersion: 1,
      referenceKind: 'skill_operation',
      referenceId: observation.operationId,
      createdAtMs: atMs,
      properties: {
        ...skillOperationProperties(
          observation.operationId,
          action,
          'owner_return',
          result,
          { ...context, authority: context.authority ?? 'owner_return' },
          atMs,
          'native_domain'
        ),
      },
    });
  } catch (ignoredError) {
    void ignoredError;
  }
}

export function publishCommittedSkillObservation(
  readCommitted: () => CommittedSkillObservation | null
): boolean {
  try {
    return enqueueOptionalAnalyticsEventFromReceipt(() => {
      const receipt = readCommitted();
      if (!receipt) return null;
      return {
        origin: receipt.origin,
        event: {
          eventId: receipt.eventId,
          eventName: SKILL_OPERATION_OBSERVED,
          payloadSchemaVersion: 1,
          referenceKind: 'skill_operation',
          referenceId: receipt.operationId,
          createdAtMs: receipt.atMs,
          properties: { ...receipt.properties },
        },
      };
    });
  } catch {
    return false;
  }
}

export function skillRequestObservationContext(
  value: unknown,
  source: SkillObservationContext['source']
): SkillObservationContext {
  try {
    const request =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      host: closedSkillValue(request.provider, SKILL_HOSTS, 'unknown'),
      source,
      scope:
        request.scope === 'global' || request.scope === 'workspace'
          ? request.scope
          : request.workspacePath === null
            ? 'global'
            : typeof request.workspacePath === 'string'
              ? 'current_context'
              : 'unknown',
    };
  } catch {
    return { source };
  }
}
