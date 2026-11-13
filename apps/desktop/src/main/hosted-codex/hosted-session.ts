import {
  HOSTED_CODEX_RESERVED_TOOLS,
  HOSTED_RESPONSES_MAX_TOOLS,
  type HostedStreamEvent,
} from '@waypoint/hosted-ai-contract';

import type { ResolvedCodexAppServerBinary } from './app-server-binary';
import { HOSTED_CODEX_MODEL_SLUG } from './app-server-config';
import { launchAppServer, type LaunchedAppServer, type SpawnLike } from './app-server-launcher';
import { createAppServerTurnDriver, type AppServerTurnDriver } from './app-server-turn-driver';
import { buildHostedProviderToolCatalog } from './hosted-tool-discovery';
import { createHostedGatewayToolProjection } from './hosted-gateway-tool-projection';
import type { HostedToolInventorySummaryCounts } from './tool-inventory-observation';
import type { IncomingServerRequest } from './app-server-supervisor';
import type { AgentStateCapsuleStore } from './agent-state-capsule';
import {
  buildHostedCodexToolCatalog,
  HostedCodexToolCatalogError,
  type HostedCodexToolCatalog,
  type ToolEffect,
} from './dynamic-tool-catalog';
import { createRunBudget, type RunBudgetLimits } from './run-budget';
import type { AcceptedResponsesRequest } from './responses-wire';
import { HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS } from './responses-wire';
import {
  startResponsesServer,
  type ResponsesRequestSizeTrace,
  type ResponsesServer,
  type ResponsesTransportTrace,
  type ResponsesStepDiagnostics,
} from './responses-server';
import { createTurnCoordinator, type TurnCoordinator } from './turn-coordinator';
import { createRecordingTurn, recoverTurn } from './turn-recovery';
import {
  runHostedTurn,
  type ChildNotification,
  type HostedTurnResult,
  type RunHostedTurnOptions,
} from './turn-loop';

export const DEFAULT_RUN_BUDGET: RunBudgetLimits = {
  providerAttempts: 24,
  totalTokens: 2_000_000,
  spendMicros: 5_000_000,
  toolCalls: 200,
  mutations: 50,
  parallelEffects: 4,
  compactions: 8,
  recoveries: 3,
  deadlineMs: 30 * 60_000,
};

export { HOSTED_CODEX_RESERVED_TOOLS } from '@waypoint/hosted-ai-contract';

export interface HostedSession {
  readonly turn: TurnCoordinator;
  readonly endpoint: ResponsesServer;
  readonly appServer: LaunchedAppServer;
  readonly driver: AppServerTurnDriver;
  readonly catalog: HostedCodexToolCatalog;
  getToolInventorySummary(): HostedToolInventorySummaryCounts;
  runTurn(
    options: Omit<RunHostedTurnOptions, 'turn' | 'driver' | 'catalog' | 'onToolDiscovery'>
  ): Promise<HostedTurnResult>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface HostedSessionOptions {
  readonly binary: ResolvedCodexAppServerBinary;
  readonly rootDir: string;
  readonly runId: string;
  readonly model: typeof HOSTED_CODEX_MODEL_SLUG;
  readonly store: AgentStateCapsuleStore;
  readonly step: (request: AcceptedResponsesRequest) => AsyncIterable<HostedStreamEvent>;
  readonly developerInstructions?: string;
  readonly priorConversationContext?: string | null;
  readonly allowEffects?: readonly ToolEffect[];
  readonly limits?: RunBudgetLimits;
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnLike;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly onTransportTrace?: (trace: ResponsesTransportTrace) => void;
  readonly onRequestSizeTrace?: (trace: ResponsesRequestSizeTrace) => void;
  readonly onEndpointStarted?: (endpoint: ResponsesServer) => void;
}

export async function runHostedTurnAfterStartupBarrier(
  session: Pick<HostedSession, 'stop'>,
  stopRequested: () => boolean,
  runTurn: () => Promise<HostedTurnResult>
): Promise<HostedTurnResult> {
  if (stopRequested()) {
    await session.stop();
    return { outcome: 'stopped', text: '' };
  }
  return runTurn();
}

export async function startHostedSession(options: HostedSessionOptions): Promise<HostedSession> {
  const catalog = buildHostedCodexToolCatalog({
    allowEffects: options.allowEffects,
    omitNames: HOSTED_CODEX_RESERVED_TOOLS,
  });
  const providerCatalog = buildHostedProviderToolCatalog(catalog);
  const toolCount =
    providerCatalog.tools.length + Object.keys(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS).length;
  if (toolCount > HOSTED_RESPONSES_MAX_TOOLS) {
    throw new HostedCodexToolCatalogError(
      'tool_limit_exceeded',
      `Hosted tool catalog has ${toolCount} tools; the request limit is ${HOSTED_RESPONSES_MAX_TOOLS}`
    );
  }

  const budget = createRunBudget({
    limits: options.limits ?? DEFAULT_RUN_BUDGET,
    now: options.now ?? (() => Date.now()),
    spent: recoverTurn(options.store.readActive(options.runId)).spentBudget,
  });
  const turn = createRecordingTurn({
    runId: options.runId,
    store: options.store,
    coordinator: createTurnCoordinator({ budget }),
    generations: { catalog: catalog.digest, model: options.model },
  });

  let firstProviderStepIsPrecharged = true;
  const gatewayTools = createHostedGatewayToolProjection(catalog);
  const recordedStep = (
    accepted: AcceptedResponsesRequest,
    diagnostics: ResponsesStepDiagnostics
  ): AsyncIterable<HostedStreamEvent> => {
    if (firstProviderStepIsPrecharged) {
      firstProviderStepIsPrecharged = false;
    } else {
      turn.beginProviderStep();
    }
    return (async function* (): AsyncGenerator<HostedStreamEvent> {
      let completedNormally = false;
      let failureReason = 'the provider step was canceled before completion';
      try {
        const projected = gatewayTools.project(accepted, (counts) =>
          diagnostics.observeToolInventory({
            ...counts,
            authorizationCatalogDefinitionCount: catalog.tools.length,
            registeredChildDefinitionCount: toolCount,
          })
        );
        for await (const event of options.step(projected)) {
          if (event.event === 'tool_call' || event.event === 'child_tool_call') {
            turn.chargeToolCall();
          }
          if (event.event === 'finish') {
            const { inputTokens, outputTokens, reasoningTokens } = event.usage;
            const tokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0);
            if (tokens > 0) turn.chargeUsage({ tokens });
          }
          yield event;
        }
        completedNormally = true;
      } catch (cause) {
        failureReason = cause instanceof Error ? cause.message : 'the provider step failed';
        throw cause;
      } finally {
        if (completedNormally) turn.finishProviderStep();
        else turn.failProviderStep(failureReason);
      }
    })();
  };

  const endpoint = await startResponsesServer({
    model: options.model,
    tools: providerCatalog.tools,
    dispatchedToolNames: catalog.tools
      .filter((tool) => !providerCatalog.tools.some((offered) => offered.name === tool.name))
      .map((tool) => tool.name),
    step: recordedStep,
    onTransportTrace: options.onTransportTrace,
    onRequestSizeTrace: options.onRequestSizeTrace,
  });
  options.onEndpointStarted?.(endpoint);

  let appServer: LaunchedAppServer;
  let notificationListener: ((notification: ChildNotification) => void) | null = null;
  let serverRequestListener: ((request: IncomingServerRequest) => void) | null = null;
  try {
    appServer = await launchAppServer({
      binary: options.binary,
      rootDir: options.rootDir,
      runId: options.runId,
      hostEnv: options.hostEnv,
      platform: options.platform,
      spawn: options.spawn,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      hostedProviderBaseUrl: `${endpoint.baseUrl}/v1`,
      onNotification: (notification) => notificationListener?.(notification),
      onServerRequest: (request) => {
        const listener = serverRequestListener;
        if (listener) listener(request);
        else request.refuse('the Hosted turn has no request handler');
      },
      injectedEnv: {
        OPENAI_API_KEY: endpoint.bearerToken,
      },
    });
  } catch (cause) {
    await endpoint.close();
    throw cause;
  }

  const driver = createAppServerTurnDriver({
    transport: {
      request: (method, params) => appServer.supervisor.request(method, params),
      onNotification: (listener) => {
        notificationListener = listener;
      },
      onServerRequest: (listener) => {
        serverRequestListener = listener;
      },
      onExit: (listener) => appServer.supervisor.onExit(listener),
    },
    model: options.model,
    cwd: appServer.isolation.cwd,
    catalog,
    offeredCatalog: providerCatalog,
    developerInstructions: options.developerInstructions,
    priorConversationContext: options.priorConversationContext,
  });

  const close = async (): Promise<void> => {
    appServer.dispose();
    await endpoint.close();
  };

  appServer.supervisor.onExit(() => {
    void endpoint.close();
  });

  return {
    turn,
    endpoint,
    appServer,
    driver,
    catalog,
    getToolInventorySummary: () => ({
      ...gatewayTools.inventorySummary(),
      authorizationCatalogDefinitionCount: catalog.tools.length,
      registeredChildDefinitionCount: toolCount,
    }),
    runTurn: (turnOptions) =>
      runHostedTurn({
        ...turnOptions,
        turn,
        driver,
        catalog,
        onToolDiscovery: (result) => {
          gatewayTools.remember(result.tools);
        },
      }),
    stop: async () => {
      turn.stop();
      await driver.interrupt();
      appServer.dispose();
    },
    close,
  };
}
