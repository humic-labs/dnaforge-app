import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HostedCodexArtifactIdentityShape } from '../../shared/hosted-codex-ipc';
import { hostedCodexStoppedAnswer } from '../../shared/hosted-codex-stopped-answer';
import type { HostedCodexGatewayProvenance } from './hosted-gateway-workflow';
import type { ResponsesRequestSizeTrace, ResponsesTransportTrace } from './responses-server';
import type { TurnOutcome } from './turn-coordinator';
import type { HostedTurnFailure } from './turn-loop';
import {
  copyHostedToolInventoryObservation,
  copyHostedToolInventorySummary,
  type HostedToolInventorySummaryObservation,
} from './tool-inventory-observation';

export const HOSTED_CODEX_TURN_JOURNAL_SCHEMA_VERSION = 1 as const;
export const HOSTED_CODEX_TURN_JOURNAL_FILE = 'hosted-codex-turns.jsonl';

export interface HostedCodexTurnJournalRecord {
  readonly schemaVersion: typeof HOSTED_CODEX_TURN_JOURNAL_SCHEMA_VERSION;
  readonly recordedAt: string;
  readonly identity: {
    readonly workflowId: string;
    readonly runId: string;
    readonly turnId: string;
  };
  readonly gateway: HostedCodexGatewayProvenance;
  readonly artifact: HostedCodexArtifactIdentityShape;
  readonly transport: {
    readonly requestSizes: readonly ResponsesRequestSizeTrace[];
    readonly responseStreams: readonly ResponsesTransportTrace[];
    readonly toolInventorySummary?: HostedToolInventorySummaryObservation;
    readonly childFailure: HostedTurnFailure | null;
  };
  readonly outcome: TurnOutcome;
  readonly answerSha256: string;
}

export interface AppendHostedCodexTurnJournalInput {
  readonly userDataRoot: string;
  readonly recordedAt?: Date;
  readonly identity: HostedCodexTurnJournalRecord['identity'];
  readonly gateway: HostedCodexGatewayProvenance;
  readonly artifact: HostedCodexArtifactIdentityShape;
  readonly transport: HostedCodexTurnJournalRecord['transport'];
  readonly outcome: TurnOutcome;
  readonly answer: string;
}

export function hostedCodexAnswerSha256(answer: string): string {
  return createHash('sha256').update(answer, 'utf8').digest('hex');
}

export async function appendHostedCodexTurnJournal(
  input: AppendHostedCodexTurnJournalInput
): Promise<HostedCodexTurnJournalRecord> {
  const record: HostedCodexTurnJournalRecord = {
    schemaVersion: HOSTED_CODEX_TURN_JOURNAL_SCHEMA_VERSION,
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    identity: { ...input.identity },
    gateway: {
      gatewayOrigin: input.gateway.gatewayOrigin,
      catalogVersion: input.gateway.catalogVersion,
      rateCardVersion: input.gateway.rateCardVersion,
      reservationIds: [...input.gateway.reservationIds],
      usageEventIds: [...input.gateway.usageEventIds],
      workflowRunId: input.gateway.workflowRunId,
      workflowStepId: input.gateway.workflowStepId,
      completedToolCallIds: [...input.gateway.completedToolCallIds],
      providerAttempts: input.gateway.providerAttempts,
      terminalError: input.gateway.terminalError ? { ...input.gateway.terminalError } : null,
    },
    artifact: { ...input.artifact },
    transport: {
      ...(input.transport.toolInventorySummary === undefined
        ? {}
        : {
            toolInventorySummary: copyHostedToolInventorySummary(
              input.transport.toolInventorySummary
            ),
          }),
      requestSizes: input.transport.requestSizes.map((trace) => ({ ...trace })),
      responseStreams: input.transport.responseStreams.map((trace) => ({
        ...trace,
        ...(trace.toolInventory === undefined
          ? {}
          : {
              toolInventory: copyHostedToolInventoryObservation(trace.toolInventory),
            }),
        gatewayEvents: trace.gatewayEvents.map((event) => ({
          ...event,
          fields: { ...event.fields },
        })),
        responsesEvents: trace.responsesEvents.map((event) => ({
          ...event,
          fields: { ...event.fields },
        })),
      })),
      childFailure: input.transport.childFailure ? { ...input.transport.childFailure } : null,
    },
    outcome: input.outcome,
    answerSha256: hostedCodexAnswerSha256(
      input.outcome === 'stopped' ? hostedCodexStoppedAnswer(input.answer) : input.answer
    ),
  };
  const directory = join(input.userDataRoot, 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, HOSTED_CODEX_TURN_JOURNAL_FILE), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return record;
}
