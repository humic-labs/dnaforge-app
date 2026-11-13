import type { AgentTransport } from '../../platform';
import {
  hostedAiEnabledInThisBuild,
  type AssistantHostDescriptor,
  type AssistantRouteState,
} from './assistant-hosts';
import {
  getActiveAssistantRoute,
  getAssistantHostDescriptorsForRuntime,
  getAssistantRouteLabel,
  getAssistantRouteReadiness,
  getAssistantRouteReadinessLabel,
  getDefaultAssistantRouteCandidates,
  isAssistantRouteSendBlocked,
  isAssistantRouteUnresolved,
  isSameAssistantRoute,
  normalizeAssistantRoute,
  shortenModelName,
  type AssistantRouteReadiness,
  type AssistantRouteSelection,
} from './assistant-routes';
import { getProviderMeta, type ProviderName } from './providers';

export type AssistantSendRouteResolution =
  | { status: 'unresolved' }
  | { status: 'blocked'; preferred: AssistantRouteSelection | null }
  | { status: 'selected'; route: AssistantRouteSelection }
  | {
      status: 'fallback';
      route: AssistantRouteSelection;
      preferred: AssistantRouteSelection;
      preferredReadiness: AssistantRouteReadiness;
    };

export function resolveAssistantSendRoute(
  state: AssistantRouteState,
  hostedAiEnabled: boolean = hostedAiEnabledInThisBuild(),
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): AssistantSendRouteResolution {
  if (isAssistantRouteUnresolved(state, hostDescriptors)) return { status: 'unresolved' };
  const preferred = getActiveAssistantRoute(state, hostedAiEnabled, hostDescriptors);
  if (!preferred) return { status: 'blocked', preferred: null };
  if (!isAssistantRouteSendBlocked(state, hostDescriptors)) {
    return { status: 'selected', route: preferred };
  }

  const preferredReadiness = getAssistantRouteReadiness(preferred, state, hostDescriptors);
  if (preferredReadiness === 'checking') return { status: 'blocked', preferred };

  for (const candidate of getDefaultAssistantRouteCandidates(state, hostDescriptors)) {
    const route = normalizeAssistantRoute(candidate.selection);
    if (route.kind === 'hosted' && !hostedAiEnabled) continue;
    if (isSameAssistantRoute(route, preferred)) continue;
    if (candidate.availability === 'pending') return { status: 'unresolved' };
    if (candidate.availability === 'ready') {
      return { status: 'fallback', route, preferred, preferredReadiness };
    }
  }
  return { status: 'blocked', preferred };
}

export function isAssistantSendRouteUsable(
  resolution: AssistantSendRouteResolution
): resolution is Extract<AssistantSendRouteResolution, { status: 'selected' | 'fallback' }> {
  return resolution.status === 'selected' || resolution.status === 'fallback';
}

const CLI_VENDOR_LABELS: Record<AgentTransport, string> = {
  'claude-agent-sdk': 'Anthropic',
  'codex-sdk': 'OpenAI',
  'grok-acp': 'xAI',
};

function providerLabel(provider: ProviderName): string {
  try {
    return getProviderMeta(provider).label;
  } catch {
    return provider;
  }
}

function routeName(route: AssistantRouteSelection): string {
  if (route.kind === 'provider') return `${providerLabel(route.provider)} API`;
  return getAssistantRouteLabel(route);
}

function routeDestination(route: AssistantRouteSelection): string {
  if (route.kind === 'cli') return `${routeName(route)} (${CLI_VENDOR_LABELS[route.transport]})`;
  if (route.kind === 'provider') {
    return `${routeName(route)} (${shortenModelName(route.model)})`;
  }
  if (route.kind === 'hosted') return `DNAForge AI (${route.tier === 'deep' ? 'Deep' : 'Auto'})`;
  return routeName(route);
}

function unavailableReason(
  route: AssistantRouteSelection,
  readiness: AssistantRouteReadiness
): string {
  if (readiness === 'needs-login') {
    return route.kind === 'hosted' ? 'needs sign-in' : 'is signed out';
  }
  if (readiness === 'missing') return 'is not installed';
  if (readiness === 'needs-key') return 'has no API key';
  if (readiness === 'key-error') return 'failed its API key check';
  if (readiness === 'unavailable') return 'is unavailable';
  const label = getAssistantRouteReadinessLabel(readiness);
  return label ? `is unavailable (${label.toLowerCase()})` : 'is unavailable';
}

export function describeAssistantRouteFallback(
  resolution: Extract<AssistantSendRouteResolution, { status: 'fallback' }>
): string {
  return `${routeName(resolution.preferred)} ${unavailableReason(
    resolution.preferred,
    resolution.preferredReadiness
  )} — sent with ${routeDestination(resolution.route)}`;
}

export function describePendingAssistantRouteFallback(
  resolution: Extract<AssistantSendRouteResolution, { status: 'fallback' }>
): string {
  return describeAssistantRouteFallback(resolution).replace(' — sent with ', ' — will send with ');
}
