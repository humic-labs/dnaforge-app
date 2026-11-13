import { randomUUID } from 'node:crypto';
import {
  EXTERNAL_ACCESS_ENUMS,
  projectExternalAccessObservation,
  type ExternalAccessObservation,
} from '../shared/external-access-telemetry';

type AccessSink = (observation: ExternalAccessObservation) => boolean;
let sink: AccessSink | null = null;
let diagnosticSink: AccessSink | null = null;
const windows = new Map<string, { timestamps: number[]; suppressedUntil: number }>();
const registrations = new Map<string, string>();

export function bindExternalAccessObservationSink(
  next: AccessSink | null,
  diagnostic: AccessSink | null = null
): void {
  sink = next;
  diagnosticSink = diagnostic;
  windows.clear();
  registrations.clear();
}

export function observeExternalAccess(value: unknown): boolean {
  try {
    const observation = projectExternalAccessObservation(value);
    if (!observation || !sink) return false;
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.timestamps.every((timestamp) => timestamp <= now - 60_000)) windows.delete(key);
    }
    const key = JSON.stringify(
      (Object.keys(EXTERNAL_ACCESS_ENUMS) as (keyof typeof EXTERNAL_ACCESS_ENUMS)[]).map(
        (field) => observation[field]
      )
    );
    const window = windows.get(key) ?? { timestamps: [], suppressedUntil: 0 };
    window.timestamps = window.timestamps.filter((timestamp) => timestamp > now - 60_000);
    windows.set(key, window);
    if (window.timestamps.length >= 60) {
      if (now >= window.suppressedUntil) {
        window.suppressedUntil = now + 60_000;
        diagnosticSink?.(observation);
      }
      return false;
    }
    window.timestamps.push(now);
    return sink(observation);
  } catch {
    return false;
  }
}

export function observeExternalRegistration(client: string, result: string): void {
  try {
    const clients: Record<string, ExternalAccessObservation['access_client']> = {
      'Claude Code': 'claude_code',
      Codex: 'codex',
      'Grok Build': 'grok_build',
      'Claude Desktop': 'desktop',
      Cursor: 'desktop',
      Windsurf: 'desktop',
    };
    const results: Record<string, ExternalAccessObservation['access_result']> = {
      registered: 'registered',
      current: 'current',
      repaired: 'repaired',
      'not-installed': 'not_installed',
      'name-conflict': 'name_conflict',
      failed: 'failed',
    };
    if (registrations.get(client) === result) return;
    const accepted = observeExternalAccess({
      feature_area: 'tool_usage',
      operation_id: randomUUID(),
      occurred_at_ms: Date.now(),
      access_stage: 'registration',
      access_result: results[result] ?? 'unknown',
      access_client: clients[client] ?? 'unknown',
      access_transport: 'configuration',
      access_scope_class: 'not_observed',
      access_expiry_class: 'not_observed',
      access_authority: 'native_configuration',
      access_execution: 'not_observed',
      access_usefulness: 'not_attested',
    });
    if (accepted) registrations.set(client, result);
  } catch (_error) {
    void _error;
  }
}
