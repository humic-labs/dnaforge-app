import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  bindExternalAccessObservationSink,
  observeExternalAccess,
  observeExternalRegistration,
} from './external-access-observation';
import type { ExternalAccessObservation } from '../shared/external-access-telemetry';

function observation(): ExternalAccessObservation {
  return {
    feature_area: 'tool_usage',
    operation_id: randomUUID(),
    occurred_at_ms: Date.now(),
    access_stage: 'registration',
    access_result: 'not_installed',
    access_client: 'codex',
    access_transport: 'configuration',
    access_scope_class: 'not_observed',
    access_expiry_class: 'not_observed',
    access_authority: 'native_configuration',
    access_execution: 'not_observed',
    access_usefulness: 'not_attested',
  };
}

afterEach(() => {
  bindExternalAccessObservationSink(null);
  vi.useRealTimers();
});

it('bounds a thousand unique envelopes of one class and resumes after the rolling window', () => {
  vi.useFakeTimers();
  const sink = vi.fn<(value: ExternalAccessObservation) => boolean>(() => true);
  const diagnostic = vi.fn(() => true);
  bindExternalAccessObservationSink(sink, diagnostic);
  for (let i = 0; i < 1_000; i++) observeExternalAccess(observation());
  expect(sink).toHaveBeenCalledTimes(60);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(59_999);
  expect(observeExternalAccess(observation())).toBe(false);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  for (let i = 0; i < 1_000; i++) observeExternalAccess(observation());
  expect(sink).toHaveBeenCalledTimes(120);
  expect(diagnostic).toHaveBeenCalledTimes(2);
});

it('retains the rolling limit across clock-minute boundaries and separates result classes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(59_000);
  const sink = vi.fn<(value: ExternalAccessObservation) => boolean>(() => true);
  const diagnostic = vi.fn(() => true);
  bindExternalAccessObservationSink(sink, diagnostic);
  for (let i = 0; i < 30; i++) observeExternalAccess(observation());
  vi.advanceTimersByTime(2_000);
  for (let i = 0; i < 31; i++) observeExternalAccess(observation());
  expect(sink).toHaveBeenCalledTimes(60);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(observeExternalAccess({ ...observation(), access_result: 'failed' })).toBe(true);
  vi.advanceTimersByTime(58_000);
  for (let i = 0; i < 31; i++) observeExternalAccess(observation());
  expect(sink).toHaveBeenCalledTimes(91);
  expect(diagnostic).toHaveBeenCalledTimes(1);
});

it('emits registration changes once and preserves a later transition back to an earlier state', () => {
  const sink = vi.fn<(value: ExternalAccessObservation) => boolean>(() => true);
  bindExternalAccessObservationSink(sink);
  observeExternalRegistration('Codex', 'not-installed');
  observeExternalRegistration('Codex', 'not-installed');
  observeExternalRegistration('Codex', 'registered');
  observeExternalRegistration('Codex', 'registered');
  observeExternalRegistration('Codex', 'not-installed');
  expect(sink.mock.calls.map(([value]) => value.access_result)).toEqual([
    'not_installed',
    'registered',
    'not_installed',
  ]);
});
