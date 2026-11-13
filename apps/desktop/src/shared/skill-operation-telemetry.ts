export const SKILL_ACTIONS = [
  'discover',
  'review',
  'install',
  'update',
  'save',
  'import',
  'enable',
  'disable',
  'inherit',
  'remove',
  'instruction_load',
  'cancel',
  'unknown',
] as const;
export const SKILL_HOSTS = ['all', 'codex-sdk', 'claude-agent-sdk', 'grok-acp', 'unknown'] as const;
export const SKILL_SCOPES = ['global', 'workspace', 'current_context', 'unknown'] as const;
export const SKILL_SOURCES = [
  'catalog',
  'local',
  'managed',
  'provider_native',
  'mixed',
  'unknown',
] as const;
export const SKILL_STAGES = [
  'intent',
  'owner_return',
  'mutation',
  'readback',
  'runtime',
  'instruction',
] as const;
export const SKILL_RESULTS = [
  'requested',
  'accepted',
  'partial',
  'reviewed',
  'review_only',
  'cancelled',
  'refused',
  'failed',
  'superseded',
  'manifest_committed',
  'inventory_matched',
  'inventory_returned',
  'inventory_unavailable',
  'runtime_returned',
  'runtime_unavailable',
  'instruction_returned',
  'instruction_refused',
  'supporting_file_returned',
] as const;
export const SKILL_AUTHORITIES = [
  'surface',
  'owner_return',
  'committed_domain_receipt',
  'native_inventory',
  'runtime_snapshot',
  'approved_locator_read',
  'compatibility_read',
  'not_attested',
] as const;
export const SKILL_ENABLEMENT = ['enabled', 'disabled', 'not_attested'] as const;
export const SKILL_RUNTIME = ['discovered', 'unavailable', 'not_attested'] as const;
export const SKILL_INSTRUCTION = [
  'full',
  'truncated',
  'supporting_file',
  'refused',
  'not_attested',
] as const;
export const SKILL_FRESHNESS = [
  'intent',
  'current_readback',
  'approved_at_admission',
  'superseded',
  'not_attested',
] as const;
export type SkillAction = (typeof SKILL_ACTIONS)[number];
export interface SkillObservationContext {
  host?: (typeof SKILL_HOSTS)[number];
  scope?: (typeof SKILL_SCOPES)[number];
  source?: (typeof SKILL_SOURCES)[number];
  authority?: (typeof SKILL_AUTHORITIES)[number];
  freshness?: (typeof SKILL_FRESHNESS)[number];
  installed?: 'installed' | 'not_attested';
  storedEnablement?: (typeof SKILL_ENABLEMENT)[number];
  effectiveEnablement?: (typeof SKILL_ENABLEMENT)[number];
  runtime?: (typeof SKILL_RUNTIME)[number];
  instruction?: (typeof SKILL_INSTRUCTION)[number];
  observedAtMs?: number;
}
export const SKILL_OPERATION_OBSERVED = 'skill_operation_observed' as const;
export interface SkillOperationProperties {
  feature_area: 'tool_usage';
  operation_id: string;
  occurred_at_ms: number;
  skills_action: SkillAction;
  skills_stage: (typeof SKILL_STAGES)[number];
  skills_result: (typeof SKILL_RESULTS)[number];
  skills_host: (typeof SKILL_HOSTS)[number];
  skills_scope: (typeof SKILL_SCOPES)[number];
  skills_source: (typeof SKILL_SOURCES)[number];
  skills_authority: (typeof SKILL_AUTHORITIES)[number];
  skills_freshness: (typeof SKILL_FRESHNESS)[number];
  skills_installed: 'installed' | 'not_attested';
  skills_stored_enablement: (typeof SKILL_ENABLEMENT)[number];
  skills_effective_enablement: (typeof SKILL_ENABLEMENT)[number];
  skills_runtime_discovery: (typeof SKILL_RUNTIME)[number];
  skills_instruction_load: (typeof SKILL_INSTRUCTION)[number];
  skills_task_reuse: 'not_attested';
  skills_operation_relation: 'observation_only_native_not_exported';
  skills_occurrence_clock: 'client' | 'native_domain';
  skills_observation_clock: 'native_or_client_observed' | 'unknown';
  skills_observed_at_ms?: number;
}
export function closedSkillValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
export function skillOperationProperties(
  id: string,
  action: SkillAction,
  stage: SkillOperationProperties['skills_stage'],
  result: SkillOperationProperties['skills_result'],
  context: SkillObservationContext = {},
  occurredAtMs = Date.now(),
  clock: 'client' | 'native_domain' = 'client'
): SkillOperationProperties {
  const observed =
    typeof context.observedAtMs === 'number' &&
    Number.isFinite(context.observedAtMs) &&
    context.observedAtMs >= 0
      ? context.observedAtMs
      : null;
  return {
    feature_area: 'tool_usage',
    operation_id: id,
    occurred_at_ms: occurredAtMs,
    skills_action: closedSkillValue(action, SKILL_ACTIONS, 'unknown'),
    skills_stage: closedSkillValue(stage, SKILL_STAGES, 'owner_return'),
    skills_result: closedSkillValue(result, SKILL_RESULTS, 'refused'),
    skills_host: closedSkillValue(context.host, SKILL_HOSTS, 'unknown'),
    skills_scope: closedSkillValue(context.scope, SKILL_SCOPES, 'unknown'),
    skills_source: closedSkillValue(context.source, SKILL_SOURCES, 'unknown'),
    skills_authority: closedSkillValue(context.authority, SKILL_AUTHORITIES, 'not_attested'),
    skills_freshness: closedSkillValue(context.freshness, SKILL_FRESHNESS, 'not_attested'),
    skills_installed: context.installed === 'installed' ? 'installed' : 'not_attested',
    skills_stored_enablement: closedSkillValue(
      context.storedEnablement,
      SKILL_ENABLEMENT,
      'not_attested'
    ),
    skills_effective_enablement: closedSkillValue(
      context.effectiveEnablement,
      SKILL_ENABLEMENT,
      'not_attested'
    ),
    skills_runtime_discovery: closedSkillValue(context.runtime, SKILL_RUNTIME, 'not_attested'),
    skills_instruction_load: closedSkillValue(
      context.instruction,
      SKILL_INSTRUCTION,
      'not_attested'
    ),
    skills_task_reuse: 'not_attested',
    skills_operation_relation: 'observation_only_native_not_exported',
    skills_occurrence_clock: clock,
    skills_observation_clock: observed === null ? 'unknown' : 'native_or_client_observed',
    ...(observed === null ? {} : { skills_observed_at_ms: observed }),
  };
}
