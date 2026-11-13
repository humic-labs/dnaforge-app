import type {
  HostedCodexContributionRequest,
  HostedCodexContributionResult,
  HostedCodexPreparedTurnCancelRequest,
  HostedCodexPreparedTurnCancelResult,
  HostedCodexTurnEvent,
  HostedCodexTurnResult,
  HostedCodexTurnStartRequest,
  HostedCodexTurnStopRequest,
  HostedCodexTurnStopResult,
} from '../hosted-codex-ipc';
import { defineGroup, event, invoke } from './contract';

export const hostedCodexContract = defineGroup('hostedCodex', {
  prepareContribution: invoke<
    [request: HostedCodexContributionRequest],
    HostedCodexContributionResult
  >(),
  cancelPreparedTurn: invoke<
    [request: HostedCodexPreparedTurnCancelRequest],
    HostedCodexPreparedTurnCancelResult
  >(),
  startTurn: invoke<[request: HostedCodexTurnStartRequest], HostedCodexTurnResult>(),
  stopTurn: invoke<[request: HostedCodexTurnStopRequest], HostedCodexTurnStopResult>(),
  onTurnEvent: event<[event: HostedCodexTurnEvent]>().channel('hostedCodex:turnEvent'),
});
