import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  HostedCodexContributionResult,
  HostedCodexTurnIdentity,
} from '../../shared/hosted-codex-ipc';
import type { HostedAiRouteAvailabilityResult } from '../../shared/hosted-ai-gateway-ipc';

export const HOSTED_CODEX_ADMISSION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const HOSTED_CODEX_ROUTE_AVAILABILITY_JOURNAL_SCHEMA_VERSION = 2 as const;
export const HOSTED_CODEX_ADMISSION_JOURNAL_FILE = 'hosted-codex-admissions.jsonl';
export const HOSTED_CODEX_ROUTE_AVAILABILITY_JOURNAL_FILE = 'hosted-codex-route-availability.jsonl';

export interface HostedCodexAdmissionJournalRecord {
  readonly schemaVersion: typeof HOSTED_CODEX_ADMISSION_JOURNAL_SCHEMA_VERSION;
  readonly recordedAt: string;
  readonly identity: HostedCodexTurnIdentity;
  readonly admitted: boolean;
  readonly decisionCode: string | null;
}

export interface HostedCodexRouteAvailabilityJournalRecord {
  readonly schemaVersion: typeof HOSTED_CODEX_ROUTE_AVAILABILITY_JOURNAL_SCHEMA_VERSION;
  readonly recordedAt: string;
  readonly available: boolean;
  readonly decisionCode: string | null;
  readonly gatewayOrigin: string | null;
}

export async function appendHostedCodexAdmissionJournal(input: {
  readonly userDataRoot: string;
  readonly recordedAt?: Date;
  readonly identity: HostedCodexTurnIdentity;
  readonly result: HostedCodexContributionResult;
}): Promise<HostedCodexAdmissionJournalRecord> {
  const record: HostedCodexAdmissionJournalRecord = {
    schemaVersion: HOSTED_CODEX_ADMISSION_JOURNAL_SCHEMA_VERSION,
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    identity: { ...input.identity },
    admitted: input.result.ok && input.result.started,
    decisionCode: input.result.ok ? null : input.result.code,
  };
  const directory = join(input.userDataRoot, 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(directory, HOSTED_CODEX_ADMISSION_JOURNAL_FILE),
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return record;
}

export async function appendHostedCodexRouteAvailabilityJournal(input: {
  readonly userDataRoot: string;
  readonly recordedAt?: Date;
  readonly result: HostedAiRouteAvailabilityResult;
}): Promise<HostedCodexRouteAvailabilityJournalRecord> {
  const record: HostedCodexRouteAvailabilityJournalRecord = {
    schemaVersion: HOSTED_CODEX_ROUTE_AVAILABILITY_JOURNAL_SCHEMA_VERSION,
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    available: input.result.ok && input.result.available,
    decisionCode: input.result.ok
      ? input.result.available
        ? null
        : input.result.reason
      : input.result.code,
    gatewayOrigin: input.result.gatewayOrigin,
  };
  const directory = join(input.userDataRoot, 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(
    join(directory, HOSTED_CODEX_ROUTE_AVAILABILITY_JOURNAL_FILE),
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  return record;
}
