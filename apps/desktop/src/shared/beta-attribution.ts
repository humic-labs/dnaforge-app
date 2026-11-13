export const BETA_ATTRIBUTION_SETTING_KEY = 'beta_attribution';

const SAFE_INVITE_ID_RE = /^bti_[a-f0-9]{16}$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface BetaAttribution {
  beta_invite_id: string;
  beta_cohort: string;
  invite_batch: string;
  connected_at?: number;
}

export function normalizeBetaAttribution(value: unknown): BetaAttribution | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.beta_invite_id !== 'string' ||
    !SAFE_INVITE_ID_RE.test(record.beta_invite_id) ||
    typeof record.beta_cohort !== 'string' ||
    !SAFE_CODE_RE.test(record.beta_cohort) ||
    typeof record.invite_batch !== 'string' ||
    !SAFE_CODE_RE.test(record.invite_batch)
  ) {
    return null;
  }

  const connectedAt =
    typeof record.connected_at === 'number' && Number.isFinite(record.connected_at)
      ? Math.trunc(record.connected_at)
      : undefined;

  return {
    beta_invite_id: record.beta_invite_id,
    beta_cohort: record.beta_cohort,
    invite_batch: record.invite_batch,
    ...(connectedAt ? { connected_at: connectedAt } : {}),
  };
}

export function parseBetaAttributionSetting(
  raw: string | null | undefined
): BetaAttribution | null {
  if (!raw) return null;
  try {
    return normalizeBetaAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function betaAttributionAnalyticsProperties(
  attribution: BetaAttribution | null
): Record<string, unknown> {
  if (!attribution) return {};
  return {
    beta_invite_id: attribution.beta_invite_id,
    beta_cohort: attribution.beta_cohort,
    invite_batch: attribution.invite_batch,
  };
}
