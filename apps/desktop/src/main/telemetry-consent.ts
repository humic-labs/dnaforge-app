import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  localeCountryCode,
  resolveAnalyticsConsentRegime,
  resolveConsentPolicy,
  type AnalyticsConsentRegime,
  type ConsentPolicyDecision,
} from '@waypoint/analytics-policy';
import type { AnalyticsConsentState } from '../shared/analytics-types';

export type TelemetryConsent = 'allowed' | 'denied' | 'unknown';

const MIRROR_FILE = 'telemetry-consent.json';

let recordedState: AnalyticsConsentState | null = null;
let mirroredState: AnalyticsConsentState | null | undefined;
const listeners = new Set<(consent: TelemetryConsent) => void>();

export function currentConsentRegime(): AnalyticsConsentRegime {
  const override = process.env.DNAFORGE_ANALYTICS_CONSENT_REGIME;
  if (!app.isPackaged && (override === 'opt_in' || override === 'opt_out')) return override;
  let countryCode: string | null = null;
  try {
    countryCode = app.getLocaleCountryCode() || localeCountryCode(app.getSystemLocale());
  } catch {
    countryCode = null;
  }
  let timeZone: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timeZone = null;
  }
  return resolveAnalyticsConsentRegime({ countryCode, timeZone });
}

export function resolveDesktopConsentPolicy(state: AnalyticsConsentState): ConsentPolicyDecision {
  return resolveConsentPolicy({
    surface: 'desktop',
    storedConsent: state.consent,
    storedVersion: state.version,
    storedBasis: state.basis,
    regime: currentConsentRegime(),
  });
}

export function getTelemetryConsent(): TelemetryConsent {
  const state = recordedState ?? readMirror();
  if (!state) return 'unknown';
  return resolveDesktopConsentPolicy(state).enabled ? 'allowed' : 'denied';
}

export function recordTelemetryConsentState(state: AnalyticsConsentState): void {
  recordedState = {
    consent: state.consent ?? null,
    version: state.version ?? null,
    basis: state.basis ?? null,
  };
  writeMirror(recordedState);
  const consent = getTelemetryConsent();
  for (const listener of listeners) {
    try {
      listener(consent);
    } catch (error) {
      console.warn('[telemetry-consent] listener failed', error);
    }
  }
}

export function onTelemetryConsentChange(
  listener: (consent: TelemetryConsent) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function mirrorPath(): string {
  return join(app.getPath('userData'), MIRROR_FILE);
}

function readMirror(): AnalyticsConsentState | null {
  if (mirroredState !== undefined) return mirroredState;
  try {
    const parsed: unknown = JSON.parse(readFileSync(mirrorPath(), 'utf8'));
    mirroredState = isConsentState(parsed) ? parsed : null;
  } catch {
    mirroredState = null;
  }
  return mirroredState;
}

function writeMirror(state: AnalyticsConsentState): void {
  mirroredState = state;
  try {
    const target = mirrorPath();
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, target);
  } catch (error) {
    console.warn('[telemetry-consent] could not write the consent mirror', error);
  }
}

function isConsentState(value: unknown): value is AnalyticsConsentState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (['consent', 'version', 'basis'] as const).every(
    (key) => record[key] === null || typeof record[key] === 'string'
  );
}

export function resetTelemetryConsentForTests(): void {
  recordedState = null;
  mirroredState = undefined;
  listeners.clear();
}
