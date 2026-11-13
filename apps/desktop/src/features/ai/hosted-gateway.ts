import {
  toUserMessage,
  userMessage,
  type UserMessage,
  type UserMessageKey,
} from '@waypoint/user-messages';
import type { HostedAiContributionGateResult } from '../../shared/hosted-ai-gateway-ipc';
import type { HostedAiBridge, HostedCodexBridge } from '../../shared/hosted-ai-bridge';
import type { HostedCodexContributionRequest } from '../../shared/hosted-codex-ipc';
import { hostedBrowserCodexBridge } from '../../hosted/ai-bridge';
import { isHostedBrowserRuntime } from '../../utils/environment';
import { hostedAiBridge as bridge } from './hosted-contribution-client';
import { useHostedContributionStore } from '../../stores/hosted-contribution-store';
export { hostedAiBridge } from './hosted-contribution-client';

export type { HostedAiBridge, HostedCodexBridge } from '../../shared/hosted-ai-bridge';

export type HostedRouteReadiness =
  | 'checking'
  | 'ready'
  | 'needs-login'
  | 'not-configured'
  | 'gateway-paused'
  | 'account-not-enabled'
  | 'workflow-unavailable'
  | 'provider-unavailable'
  | 'gateway-not-ready'
  | 'browser-agent-unavailable'
  | 'gateway-unavailable'
  | 'invalid-response'
  | 'bridge-unavailable';

type HostedBridgeWindow = Window & {
  electronAPI?: {
    hostedAi?: HostedAiBridge;
    hostedCodex?: HostedCodexBridge;
  };
};

function hostedBridgeWindow(): HostedBridgeWindow | null {
  return typeof window === 'undefined' ? null : (window as HostedBridgeWindow);
}

export function hostedCodexBridge(): HostedCodexBridge | null {
  if (isHostedBrowserRuntime()) return hostedBrowserCodexBridge;
  return hostedBridgeWindow()?.electronAPI?.hostedCodex ?? null;
}

function hostedContributionFailure(
  result: Extract<HostedAiContributionGateResult, { ok: false }>
): UserMessage {
  const keys: Record<typeof result.code, UserMessageKey> = {
    not_configured: 'assistant.unavailable',
    signed_out: 'account.signInRequired',
    invalid_request: 'assistant.failed',
    gateway_unavailable: 'service.unavailable',
    legal_acceptance_missing: 'assistant.legalReviewRequired',
    contribution_policy_stale: 'assistant.contributionCheckFailed',
    contribution_choice_rejected: 'assistant.contributionRequired',
  };
  return toUserMessage(result, keys[result.code] ?? 'assistant.contributionCheckFailed');
}

export async function prepareHostedCodexContribution(
  identity: HostedCodexContributionRequest
): Promise<{ readonly started: boolean; readonly error: UserMessage | null }> {
  const preferenceError = await useHostedContributionStore.getState().waitForSave();
  if (preferenceError)
    return {
      started: false,
      error: toUserMessage(preferenceError, 'assistant.contributionSaveFailed'),
    };
  const hostedCodex = hostedCodexBridge();
  if (!hostedCodex) {
    return {
      started: false,
      error: userMessage('assistant.unavailable'),
    };
  }
  try {
    const result = await hostedCodex.prepareContribution(identity);
    if (!result.ok) return { started: false, error: hostedContributionFailure(result) };
    return { started: result.started, error: null };
  } catch {
    return {
      started: false,
      error: userMessage('guidance.dnaforge-ai-could-not-load-the-current-contribution-policy'),
    };
  }
}

export async function prepareHostedContribution(identity: {
  readonly workflowId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly workspacePath: string | null;
}): Promise<{
  readonly started: boolean;
  readonly turnBindingToken: string | null;
  readonly error: UserMessage | null;
}> {
  const preferenceError = await useHostedContributionStore.getState().waitForSave();
  if (preferenceError)
    return {
      started: false,
      turnBindingToken: null,
      error: toUserMessage(preferenceError, 'assistant.contributionSaveFailed'),
    };
  const hostedAi = bridge();
  if (!hostedAi) {
    return {
      started: false,
      turnBindingToken: null,
      error: userMessage('assistant.unavailable'),
    };
  }
  try {
    const result = await hostedAi.prepareContribution({
      surface: 'first_hosted_attempt',
      ...identity,
    });
    if (!result.ok) {
      return {
        started: false,
        turnBindingToken: null,
        error: hostedContributionFailure(result),
      };
    }
    if (result.started && !result.turnBindingToken) {
      return {
        started: false,
        turnBindingToken: null,
        error: userMessage('assistant.turnBindingFailed'),
      };
    }
    return {
      started: result.started,
      turnBindingToken: result.turnBindingToken,
      error: null,
    };
  } catch {
    return {
      started: false,
      turnBindingToken: null,
      error: userMessage('guidance.dnaforge-ai-could-not-load-the-current-contribution-policy'),
    };
  }
}

export {
  getHostedContributionSettings,
  type HostedContributionSettingsResult,
} from './hosted-contribution-client';

export async function getHostedRouteReadiness(): Promise<HostedRouteReadiness> {
  const hostedAi = bridge();
  if (!hostedAi) return 'bridge-unavailable';
  try {
    const result = await hostedAi.getRouteAvailability();
    if (result.ok) {
      if (result.available) return 'ready';
      switch (result.reason) {
        case 'sign_in_required':
          return 'needs-login';
        case 'gateway_paused':
          return 'gateway-paused';
        case 'account_not_enabled':
          return 'account-not-enabled';
        case 'workflow_unavailable':
          return 'workflow-unavailable';
        case 'provider_unavailable':
          return 'provider-unavailable';
        case 'gateway_not_ready':
          return 'gateway-not-ready';
        case 'browser_agent_unavailable':
          return 'browser-agent-unavailable';
      }
    }
    switch (result.code) {
      case 'signed_out':
        return 'needs-login';
      case 'not_configured':
        return 'not-configured';
      case 'gateway_unavailable':
        return 'gateway-unavailable';
      case 'invalid_response':
        return 'invalid-response';
    }
  } catch {
    return 'gateway-unavailable';
  }
}
