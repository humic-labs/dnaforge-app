export const EXTERNAL_ACCESS_EVENT = 'external_access_lifecycle_observed' as const;
export const EXTERNAL_ACCESS_ENUMS = {
  access_stage: [
    'registration',
    'grant_create',
    'workspace_bind',
    'request_admitted',
    'request_outcome',
    'selected_revoke',
  ],
  access_result: [
    'registered',
    'current',
    'repaired',
    'not_installed',
    'name_conflict',
    'failed',
    'created',
    'bound',
    'revoked',
    'admitted',
    'allowed',
    'refused',
    'unknown',
  ],
  access_client: [
    'claude_code',
    'codex',
    'grok_build',
    'desktop',
    'script',
    'local_mcp',
    'unknown',
  ],
  access_transport: ['configuration', 'stdio', 'http', 'unknown'],
  access_scope_class: ['not_observed', 'read', 'write', 'broad', 'unknown'],
  access_expiry_class: ['not_observed', 'twelve_hours', 'timed', 'none', 'expired', 'unknown'],
  access_authority: [
    'native_configuration',
    'committed_grant',
    'committed_binding',
    'admitted_job',
    'committed_action',
    'transport_gate',
    'committed_revoke',
  ],
  access_execution: ['not_observed', 'queued', 'running', 'completed', 'failed', 'canceled'],
  access_usefulness: ['not_attested'],
} as const;

type ClosedAccessFields = {
  [K in keyof typeof EXTERNAL_ACCESS_ENUMS]: (typeof EXTERNAL_ACCESS_ENUMS)[K][number];
};
export type ExternalAccessObservation = ClosedAccessFields & {
  feature_area: 'tool_usage';
  operation_id: string;
  occurred_at_ms: number;
};
export const EXTERNAL_ACCESS_PROPERTY_KEYS = [
  'feature_area',
  'operation_id',
  'occurred_at_ms',
  ...Object.keys(EXTERNAL_ACCESS_ENUMS),
];
const OBSERVATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function projectExternalAccessObservation(value: unknown): ExternalAccessObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(value);
  if (
    names.length !== EXTERNAL_ACCESS_PROPERTY_KEYS.length ||
    names.some((key) => typeof key !== 'string' || !EXTERNAL_ACCESS_PROPERTY_KEYS.includes(key))
  )
    return null;
  const fields: Record<string, unknown> = {};
  for (const key of EXTERNAL_ACCESS_PROPERTY_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) return null;
    fields[key] = descriptor.value;
  }
  if (
    fields.feature_area !== 'tool_usage' ||
    typeof fields.operation_id !== 'string' ||
    !OBSERVATION_UUID.test(fields.operation_id) ||
    !Number.isSafeInteger(fields.occurred_at_ms) ||
    Number(fields.occurred_at_ms) < 0
  )
    return null;
  for (const [key, allowed] of Object.entries(EXTERNAL_ACCESS_ENUMS)) {
    if (
      typeof fields[key] !== 'string' ||
      !(allowed as readonly string[]).includes(fields[key] as string)
    )
      return null;
  }
  const pairs: Record<string, { authority: string; results: readonly string[] }> = {
    registration: {
      authority: 'native_configuration',
      results: [
        'registered',
        'current',
        'repaired',
        'not_installed',
        'name_conflict',
        'failed',
        'unknown',
      ],
    },
    grant_create: { authority: 'committed_grant', results: ['created'] },
    workspace_bind: { authority: 'committed_binding', results: ['bound'] },
    selected_revoke: { authority: 'committed_revoke', results: ['revoked'] },
    request_admitted: { authority: 'admitted_job', results: ['admitted'] },
  };
  if (fields.access_stage === 'request_outcome') {
    if (fields.access_authority === 'transport_gate') {
      if (fields.access_result !== 'refused' || fields.access_execution !== 'not_observed')
        return null;
    } else if (
      fields.access_authority !== 'committed_action' ||
      !['allowed', 'refused', 'unknown'].includes(String(fields.access_result)) ||
      !['completed', 'failed', 'canceled', 'not_observed'].includes(String(fields.access_execution))
    )
      return null;
  } else {
    const pair = pairs[String(fields.access_stage)];
    if (
      !pair ||
      fields.access_authority !== pair.authority ||
      !pair.results.includes(String(fields.access_result))
    )
      return null;
    if (fields.access_stage === 'request_admitted') {
      if (fields.access_execution !== 'queued') return null;
    } else if (fields.access_execution !== 'not_observed') return null;
  }
  if (
    fields.access_stage === 'registration' &&
    (fields.access_scope_class !== 'not_observed' || fields.access_expiry_class !== 'not_observed')
  )
    return null;
  return fields as ExternalAccessObservation;
}
