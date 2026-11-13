import {
  type UserMessage,
  type UserVisibleText,
  userMessageWithValues,
  userMessageValue,
  userMessage,
} from '@waypoint/user-messages';
import type { AgentTransport } from '../../platform';
import { resolveCliAuthorityProfileId, type CliPermissionMode } from '../../shared/agent-authority';
import { AGENT_TRANSPORT_LABELS } from './agent-cli-labels';
import {
  DEFAULT_ASSISTANT_CLI_PERMISSION_MODE,
  DEFAULT_ASSISTANT_HOST_DESCRIPTORS,
  hostedAiEnabledInThisBuild,
  type AssistantHostDescriptor,
  type AssistantHostRouteSelection,
  type AssistantHostId,
  type AssistantRouteState,
} from './assistant-hosts';
import { getProviderMeta, type ProviderName } from './providers';
import { getDetectedCliDefaultModel, getCliDefaultModelDisplayLabel } from './cli-model-catalog';
import type { HostedRouteReadiness } from './hosted-gateway';
import {
  getCustomCliHarnessDefinition,
  getCustomCliHarnessDefinitions,
} from './custom-cli-harnesses';
import {
  pickPreferredRegisteredRoute,
  type RegisteredRouteAvailability,
  type RegisteredRouteCandidate,
} from './assistant-route-policy';
import { isHostedBrowserRuntime } from '../../utils/environment';

export type AssistantRouteKind = 'provider' | 'cli' | 'hosted' | 'orchestrator' | 'team';
export type { CliPermissionMode };
export type { AssistantRouteState } from './assistant-hosts';

export const DEFAULT_CLI_PERMISSION_MODE: CliPermissionMode = DEFAULT_ASSISTANT_CLI_PERMISSION_MODE;
export const DEFAULT_ASSISTANT_CLI_TRANSPORTS: readonly AgentTransport[] =
  DEFAULT_ASSISTANT_HOST_DESCRIPTORS.flatMap((descriptor) =>
    descriptor.target.kind === 'cli' ? [descriptor.target.transport] : []
  );

export function getAssistantHostDescriptorsForRuntime(
  descriptors: readonly AssistantHostDescriptor[] = DEFAULT_ASSISTANT_HOST_DESCRIPTORS
): readonly AssistantHostDescriptor[] {
  if (!isHostedBrowserRuntime()) return descriptors;
  return descriptors.filter((descriptor) => descriptor.target.kind === 'hosted');
}

export const CLI_PERMISSION_MODE_LABELS: Record<CliPermissionMode, UserMessage> = {
  'app-supervised': userMessage('assistant.tools.appSupervised'),
  'native-cli': userMessage('assistant.tools.native'),
};

export type AssistantRouteSelection = AssistantHostRouteSelection;

export type AssistantRouteOptionCategory = 'cli' | 'api' | 'hosted' | 'future';
export type AssistantRouteReadiness =
  | 'ready'
  | 'checking'
  | 'unavailable'
  | 'needs-login'
  | 'missing'
  | 'needs-key'
  | 'key-error'
  | HostedRouteReadiness;

export interface AssistantRouteOption {
  id: AssistantHostId;
  hostId: AssistantHostId;
  selection: AssistantRouteSelection;
  category: AssistantRouteOptionCategory;
  label: string;
  detail: UserVisibleText;
  sourceLabel: UserMessage;
  settingLabel: string;
  configured: boolean;
  active: boolean;
  readiness: AssistantRouteReadiness;
  readinessLabel: UserMessage | null;
}

export interface AssistantTurnRouteSnapshot {
  routeKind: AssistantRouteKind;
  hostId: AssistantHostId;
  provider: ProviderName | null;
  model: string | null;
  transport: AgentTransport | null;
  authorityProfileId: string | null;
  permissionMode: CliPermissionMode | null;
  customHarnessId?: string | null;
  routeSnapshotJson: string;
}

export function getActiveAssistantRoute(
  state: AssistantRouteState,
  hostedAiEnabled: boolean = hostedAiEnabledInThisBuild(),
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): AssistantRouteSelection | null {
  const explicitRoute = state.assistantRoute
    ? restoreRegisteredAssistantRoute(state.assistantRoute, hostDescriptors)
    : null;
  if (explicitRoute && (explicitRoute.kind !== 'hosted' || hostedAiEnabled)) {
    return normalizeAssistantRoute(explicitRoute);
  }
  if (state.agentTransport) {
    const legacyRoute = restoreRegisteredAssistantRoute(
      {
        kind: 'cli',
        transport: state.agentTransport,
        permissionMode: DEFAULT_CLI_PERMISSION_MODE,
      },
      hostDescriptors
    );
    if (legacyRoute) return normalizeAssistantRoute(legacyRoute);
  }
  const computedDefault = pickDefaultAssistantRoute(state, hostDescriptors);
  if (computedDefault && (computedDefault.kind !== 'hosted' || hostedAiEnabled)) {
    return normalizeAssistantRoute(computedDefault);
  }
  return null;
}

export function isAssistantRouteUnresolved(
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): boolean {
  if (
    state.assistantRoute &&
    restoreRegisteredAssistantRoute(state.assistantRoute, hostDescriptors)
  ) {
    return false;
  }
  if (
    state.agentTransport &&
    restoreRegisteredAssistantRoute(
      {
        kind: 'cli',
        transport: state.agentTransport,
        permissionMode: DEFAULT_CLI_PERMISSION_MODE,
      },
      hostDescriptors
    )
  ) {
    return false;
  }
  const candidates = getDefaultAssistantRouteCandidates(state, hostDescriptors);
  const selected = pickPreferredRegisteredRoute(candidates);
  if (!selected) {
    return candidates.some((candidate) => candidate.availability === 'pending');
  }

  const selectedIndex = candidates.findIndex((candidate) => candidate.selection === selected);
  const selectedAvailability = candidates[selectedIndex]?.availability;
  if (selectedAvailability === 'setup-required') {
    return candidates.some((candidate) => candidate.availability === 'pending');
  }
  return candidates
    .slice(0, selectedIndex)
    .some((candidate) => candidate.availability === 'pending');
}

export function pickDefaultAssistantRoute(
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): AssistantRouteSelection | null {
  const candidates = getDefaultAssistantRouteCandidates(state, hostDescriptors);
  const preferred = pickPreferredRegisteredRoute(candidates);
  if (preferred || !isHostedBrowserRuntime()) return preferred;
  return candidates.find((candidate) => candidate.selection.kind === 'hosted')?.selection ?? null;
}

export function getDefaultAssistantRouteCandidates(
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): RegisteredRouteCandidate<AssistantRouteSelection>[] {
  const baseline: AssistantRouteSelection = {
    kind: 'provider',
    provider: state.provider,
    model: state.model,
  };

  return hostDescriptors.flatMap((descriptor) => {
    const selection = descriptor.createSelection(state, baseline);
    if (!selection) return [];
    return [
      {
        selection,
        availability: routeReadinessToAvailability(
          getAssistantRouteReadiness(selection, state, hostDescriptors)
        ),
      },
    ];
  });
}

function routeReadinessToAvailability(
  readiness: AssistantRouteReadiness
): RegisteredRouteAvailability {
  if (readiness === 'ready') return 'ready';
  if (readiness === 'needs-login' || readiness === 'needs-key' || readiness === 'key-error') {
    return 'setup-required';
  }
  if (readiness === 'checking') return 'pending';
  return 'unavailable';
}

export function restoreRegisteredAssistantRoute(
  value: unknown,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): AssistantRouteSelection | null {
  for (const descriptor of hostDescriptors) {
    const restored = descriptor.restoreSelection?.(value);
    if (restored) return restored;
  }
  return null;
}

export function buildAssistantTurnRouteSnapshot(
  routeInput: AssistantRouteSelection,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime(),
  hostedAiEnabled: boolean = hostedAiEnabledInThisBuild()
): AssistantTurnRouteSnapshot {
  const route = normalizeAssistantRoute(routeInput);
  if (route.kind === 'hosted' && !hostedAiEnabled) {
    throw new Error('DNAForge Hosted AI is not available in this build.');
  }
  const descriptor = getAssistantHostDescriptorForRoute(route, hostDescriptors);
  if (!descriptor) {
    throw new Error(
      `No assistant host descriptor is registered for route ${getAssistantRouteId(route)}.`
    );
  }
  const hostId = descriptor.id;
  if (!descriptor.executor) {
    throw new Error(
      `Registered assistant route ${getAssistantRouteId(route)} does not have an executor in this build.`
    );
  }
  if (!assistantExecutorAcceptsRoute(descriptor.executor, route)) {
    throw new Error(
      `Assistant executor ${descriptor.executor} rejected route ${getAssistantRouteId(route)}.`
    );
  }

  if (descriptor.executor === 'direct-api' && route.kind === 'provider') {
    return {
      routeKind: route.kind,
      hostId,
      provider: route.provider,
      model: route.model,
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify(route),
    };
  }

  if (descriptor.executor === 'cli' && route.kind === 'cli') {
    const customHarness = route.customHarnessId
      ? getCustomCliHarnessDefinition(route.customHarnessId)
      : null;
    if (route.customHarnessId && !customHarness) {
      throw new Error('The selected custom CLI harness no longer exists.');
    }
    const permissionMode = getCliPermissionMode(route);
    return {
      routeKind: route.kind,
      hostId: customHarness?.id ?? hostId,
      provider: null,
      model: null,
      transport: route.transport,
      authorityProfileId: getCliAuthorityProfileId(route),
      permissionMode,
      ...(customHarness ? { customHarnessId: customHarness.id } : {}),
      routeSnapshotJson: JSON.stringify({
        kind: route.kind,
        transport: route.transport,
        permissionMode,
        ...(customHarness ? { customHarnessId: customHarness.id } : {}),
      }),
    };
  }

  if (descriptor.executor === 'hosted' && route.kind === 'hosted') {
    return {
      routeKind: route.kind,
      hostId,
      provider: null,
      model: null,
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify(route),
    };
  }

  throw new Error(`Assistant route ${getAssistantRouteId(route)} has no snapshot implementation.`);
}

export function getAssistantRouteId(route: AssistantRouteSelection): string {
  if (route.kind === 'provider') return `provider:${route.provider}:${route.model}`;
  if (route.kind === 'cli') {
    const base = `cli:${route.transport}:${getCliPermissionMode(route)}`;
    return route.customHarnessId ? `${base}:${route.customHarnessId}` : base;
  }
  if (route.kind === 'hosted') return `hosted:${route.tier}`;
  return `${route.kind}:${route.id}`;
}

export function getAssistantRouteLabel(route: AssistantRouteSelection): string {
  if (route.kind === 'provider') {
    try {
      return getProviderMeta(route.provider).label;
    } catch {
      return userMessage('assistant.directApi');
    }
  }
  if (route.kind === 'cli') {
    return (
      getCustomCliHarnessDefinition(route.customHarnessId)?.label ??
      AGENT_TRANSPORT_LABELS[route.transport]
    );
  }
  if (route.kind === 'hosted') return 'DNAForge AI';
  if (route.kind === 'orchestrator') return 'Orchestrator';
  return 'Assistant team';
}

export function getAssistantRouteDetail(route: AssistantRouteSelection): UserVisibleText {
  if (route.kind === 'provider') return userMessageValue(shortenModelName(route.model));
  if (route.kind === 'cli') return CLI_PERMISSION_MODE_LABELS[getCliPermissionMode(route)];
  if (route.kind === 'hosted')
    return userMessage(route.tier === 'deep' ? 'assistant.route.deep' : 'assistant.route.auto');
  return userMessage('copy.assistant-connection-options');
}

export function buildAssistantRouteOptions(
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime(),
  hostedAiEnabled: boolean = hostedAiEnabledInThisBuild()
): AssistantRouteOption[] {
  const activeRoute = getActiveAssistantRoute(state, hostedAiEnabled, hostDescriptors);
  const baselineRoute: AssistantRouteSelection = {
    kind: 'provider',
    provider: state.provider,
    model: state.model,
  };
  const options: AssistantRouteOption[] = [];

  for (const descriptor of hostDescriptors) {
    if (descriptor.target.kind === 'hosted' && !hostedAiEnabled) continue;
    const selection = descriptor.createSelection(state, activeRoute ?? baselineRoute);
    if (!selection) continue;
    const readiness = getAssistantRouteReadiness(selection, state, hostDescriptors);
    const configured =
      descriptor.optionCategory !== 'future' &&
      isAssistantRouteConfigured(selection, state, hostDescriptors);
    options.push({
      id: descriptor.id,
      hostId: descriptor.id,
      selection,
      category: descriptor.optionCategory,
      label: descriptor.label,
      detail: getHostOptionDetail(descriptor, selection, configured, readiness, state),
      sourceLabel: getHostOptionSource(descriptor, selection),
      settingLabel: getHostOptionSetting(descriptor, selection, configured, readiness, state),
      configured,
      active: !!activeRoute && isSameAssistantRoute(selection, activeRoute),
      readiness,
      readinessLabel: getRouteReadinessLabel(selection, readiness),
    });
  }

  if (hostDescriptors.some((descriptor) => descriptor.target.kind === 'cli')) {
    for (const harness of getCustomCliHarnessDefinitions()) {
      const selection: AssistantRouteSelection = {
        kind: 'cli',
        transport: harness.transport,
        permissionMode: DEFAULT_CLI_PERMISSION_MODE,
        customHarnessId: harness.id,
      };
      options.push({
        id: harness.id,
        hostId: harness.id,
        selection,
        category: 'cli',
        label: harness.label,
        detail: userMessageWithValues('copy.value-compatible', {
          value0: userMessageValue(AGENT_TRANSPORT_LABELS[harness.transport]),
        }),
        sourceLabel: userMessage('assistant.source.custom'),
        settingLabel: 'Configured',
        configured: true,
        active: !!activeRoute && isSameAssistantRoute(selection, activeRoute),
        readiness: 'ready',
        readinessLabel: null,
      });
    }
  }

  return options;
}

export function isAssistantRouteConfigured(
  route: AssistantRouteSelection,
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): boolean {
  const normalizedRoute = normalizeAssistantRoute(route);
  if (!getExecutableAssistantHostDescriptor(normalizedRoute, hostDescriptors)) return false;
  if (normalizedRoute.kind === 'cli') {
    if (normalizedRoute.customHarnessId) {
      return getCustomCliHarnessDefinition(normalizedRoute.customHarnessId) !== null;
    }
    return getCliRouteReadiness(normalizedRoute.transport, state) === 'ready';
  }
  if (normalizedRoute.kind === 'provider') {
    return !!state.providerStatuses?.[normalizedRoute.provider]?.isConfigured;
  }
  if (normalizedRoute.kind === 'hosted') {
    return (state.hostedRouteReadiness ?? 'checking') === 'ready';
  }
  return true;
}

export function isAssistantRouteSendBlocked(
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): boolean {
  if (isAssistantRouteUnresolved(state, hostDescriptors)) return true;
  const route = getActiveAssistantRoute(state, undefined, hostDescriptors);
  if (!route) return true;

  const readiness = getAssistantRouteReadiness(route, state, hostDescriptors);
  if (readiness === 'unavailable') return true;
  if (route.kind === 'provider') {
    return !isAssistantRouteConfigured(route, state, hostDescriptors);
  }
  if (route.kind === 'cli') {
    return readiness === 'checking'
      ? false
      : !isAssistantRouteConfigured(route, state, hostDescriptors);
  }
  if (route.kind === 'hosted') return readiness !== 'ready';
  return !isAssistantRouteConfigured(route, state, hostDescriptors);
}

export function getAssistantRouteReadiness(
  route: AssistantRouteSelection,
  state: AssistantRouteState,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): AssistantRouteReadiness {
  const normalizedRoute = normalizeAssistantRoute(route);
  if (!getExecutableAssistantHostDescriptor(normalizedRoute, hostDescriptors)) {
    return 'unavailable';
  }
  if (normalizedRoute.kind === 'cli') {
    if (normalizedRoute.customHarnessId) {
      return getCustomCliHarnessDefinition(normalizedRoute.customHarnessId)
        ? 'ready'
        : 'unavailable';
    }
    return getCliRouteReadiness(normalizedRoute.transport, state);
  }
  if (normalizedRoute.kind === 'provider') {
    return getProviderRouteReadiness(normalizedRoute.provider, state);
  }
  if (normalizedRoute.kind === 'hosted') {
    return state.hostedRouteReadiness ?? 'checking';
  }
  return 'ready';
}

export function getAssistantRouteReadinessLabel(
  readiness: AssistantRouteReadiness
): UserMessage | null {
  if (readiness === 'unavailable') return userMessage('assistant.readiness.unavailable');
  if (readiness === 'checking') return userMessage('assistant.readiness.checking');
  if (readiness === 'needs-login') return userMessage('assistant.readiness.needs-login');
  if (readiness === 'not-configured')
    return userMessage('assistant.readiness.not-configured-in-this-build');
  if (readiness === 'gateway-paused') return userMessage('assistant.readiness.hosted-ai-is-paused');
  if (readiness === 'account-not-enabled')
    return userMessage('assistant.readiness.account-not-enabled');
  if (readiness === 'workflow-unavailable')
    return userMessage('assistant.readiness.hosted-workflow-unavailable');
  if (readiness === 'provider-unavailable')
    return userMessage('assistant.readiness.ai-provider-unavailable');
  if (readiness === 'gateway-not-ready')
    return userMessage('assistant.readiness.hosted-gateway-not-ready');
  if (readiness === 'browser-agent-unavailable')
    return userMessage('assistant.readiness.hosted-browser-agent-unavailable');
  if (readiness === 'gateway-unavailable')
    return userMessage('assistant.readiness.hosted-gateway-unreachable');
  if (readiness === 'invalid-response')
    return userMessage('assistant.readiness.invalid-gateway-response');
  if (readiness === 'bridge-unavailable')
    return userMessage('assistant.readiness.desktop-bridge-unavailable');
  if (readiness === 'missing') return userMessage('assistant.readiness.install-cli');
  if (readiness === 'needs-key') return userMessage('assistant.readiness.needs-key');
  if (readiness === 'key-error') return userMessage('assistant.readiness.check-failed');
  return null;
}

function getRouteReadinessLabel(
  route: AssistantRouteSelection,
  readiness: AssistantRouteReadiness
): UserMessage | null {
  if (route.kind === 'hosted' && readiness === 'needs-login')
    return userMessage('assistant.readiness.sign-in-required');
  return getAssistantRouteReadinessLabel(readiness);
}

function getProviderRouteReadiness(
  provider: ProviderName,
  state: AssistantRouteState
): AssistantRouteReadiness {
  if (!state.providerStatuses?.[provider]?.isConfigured) return 'needs-key';
  const modelState = state.providerModels?.[provider];
  if (modelState?.fetchStatus === 'loading') return 'checking';
  if (modelState?.fetchStatus === 'error') return 'key-error';
  return 'ready';
}

function getCliRouteReadiness(
  transport: AgentTransport,
  state: AssistantRouteState
): AssistantRouteReadiness {
  const detection =
    transport === 'codex-sdk'
      ? state.agentDetection?.codex
      : transport === 'grok-acp'
        ? state.agentDetection?.grok
        : state.agentDetection?.claudeCode;
  if (!detection) return state.agentDetectError ? 'missing' : 'checking';
  if (detection.cli === 'missing') return 'missing';
  if (detection.auth !== 'authenticated') return 'needs-login';
  return 'ready';
}

export function getAssistantHostIdForRoute(
  route: AssistantRouteSelection,
  hostDescriptors: readonly AssistantHostDescriptor[] = getAssistantHostDescriptorsForRuntime()
): AssistantHostId | null {
  return getAssistantHostDescriptorForRoute(route, hostDescriptors)?.id ?? null;
}

function getAssistantHostDescriptorForRoute(
  route: AssistantRouteSelection,
  hostDescriptors: readonly AssistantHostDescriptor[]
): AssistantHostDescriptor | null {
  return hostDescriptors.find((descriptor) => !!descriptor.restoreSelection?.(route)) ?? null;
}

function getExecutableAssistantHostDescriptor(
  route: AssistantRouteSelection,
  hostDescriptors: readonly AssistantHostDescriptor[]
): AssistantHostDescriptor | null {
  const descriptor = getAssistantHostDescriptorForRoute(route, hostDescriptors);
  return descriptor?.executor && assistantExecutorAcceptsRoute(descriptor.executor, route)
    ? descriptor
    : null;
}

function assistantExecutorAcceptsRoute(
  executor: NonNullable<AssistantHostDescriptor['executor']>,
  route: AssistantRouteSelection
): boolean {
  if (executor === 'direct-api') return route.kind === 'provider';
  if (executor === 'cli') return route.kind === 'cli';
  return route.kind === 'hosted';
}

export function isSameAssistantRoute(
  left: AssistantRouteSelection,
  right: AssistantRouteSelection
): boolean {
  return getAssistantRouteId(left) === getAssistantRouteId(right);
}

export function shortenModelName(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function getCliPermissionMode(route: Extract<AssistantRouteSelection, { kind: 'cli' }>) {
  return route.permissionMode ?? DEFAULT_CLI_PERMISSION_MODE;
}

export function getCliAuthorityProfileId(route: Extract<AssistantRouteSelection, { kind: 'cli' }>) {
  return resolveCliAuthorityProfileId({
    transport: route.transport,
    permissionMode: getCliPermissionMode(route),
  });
}

export function normalizeAssistantRoute(route: AssistantRouteSelection): AssistantRouteSelection {
  if (route.kind === 'cli') {
    return {
      kind: 'cli',
      transport: route.transport,
      permissionMode: getCliPermissionMode(route),
      ...(route.customHarnessId ? { customHarnessId: route.customHarnessId } : {}),
    };
  }
  return route;
}

function getHostOptionDetail(
  descriptor: AssistantHostDescriptor,
  selection: AssistantRouteSelection,
  configured: boolean,
  readiness: AssistantRouteReadiness,
  state: AssistantRouteState
): UserVisibleText {
  if (descriptor.target.kind === 'direct-api' && selection.kind === 'provider') {
    if (readiness === 'needs-key') return userMessage('copy.needs-api-key');
    if (readiness === 'checking') return userMessage('copy.checking-api-key');
    if (readiness === 'key-error') return userMessage('copy.key-check-failed');
    if (!configured) return userMessage('copy.needs-api-key');
    return userMessageValue(getApiHostDetail(selection));
  }
  if (descriptor.target.kind === 'cli' && selection.kind === 'cli' && !configured) {
    return getAssistantRouteReadinessLabel(readiness) ?? descriptor.detail;
  }
  if (descriptor.target.kind === 'cli' && selection.kind === 'cli') {
    return userMessageValue(getCliModelSettingsLabel(selection.transport, state));
  }
  if (descriptor.target.kind === 'hosted' && selection.kind === 'hosted') {
    return descriptor.detail;
  }
  return descriptor.detail;
}

function getHostOptionSource(
  descriptor: AssistantHostDescriptor,
  selection: AssistantRouteSelection
): UserMessage {
  if (descriptor.target.kind === 'direct-api' && selection.kind === 'provider') {
    return userMessageWithValues('assistant.providerApi', {
      provider: userMessageValue(getProviderLabel(selection.provider)),
    });
  }
  if (descriptor.target.kind === 'cli') {
    return userMessage('assistant.source.local');
  }
  if (descriptor.target.kind === 'hosted') return userMessage('assistant.source.hosted');
  return descriptor.detail;
}

function getHostOptionSetting(
  descriptor: AssistantHostDescriptor,
  selection: AssistantRouteSelection,
  configured: boolean,
  readiness: AssistantRouteReadiness,
  state: AssistantRouteState
): string {
  if (descriptor.target.kind === 'direct-api' && selection.kind === 'provider') {
    if (readiness === 'needs-key') return 'Not configured';
    if (readiness === 'checking') return 'Checking key';
    if (readiness === 'key-error') return 'Check failed';
    if (!configured) return 'Not configured';
    return shortenModelName(selection.model);
  }
  if (descriptor.target.kind === 'cli' && selection.kind === 'cli') {
    if (!configured) return getAssistantRouteReadinessLabel(readiness) ?? 'Not configured';
    return getCliModelSettingsLabel(selection.transport, state);
  }
  if (descriptor.target.kind === 'hosted' && selection.kind === 'hosted') {
    return getRouteReadinessLabel(selection, readiness) ?? descriptor.description;
  }
  return descriptor.description;
}

function getCliModelSettingsLabel(transport: AgentTransport, state: AssistantRouteState): string {
  const settings = state.cliModelSettings?.[transport];
  const model = settings?.model?.trim();
  const effort = settings?.reasoningEffort;
  const modelLabel =
    model ||
    getCliDefaultModelDisplayLabel(
      transport,
      getDetectedCliDefaultModel(state.agentDetection, transport)
    );
  return effort ? `${modelLabel} / ${effort} effort` : modelLabel;
}

function getApiHostDetail(route: Extract<AssistantRouteSelection, { kind: 'provider' }>): string {
  const providerLabel = getProviderLabel(route.provider);
  return `${providerLabel} / ${shortenModelName(route.model)}`;
}

function getProviderLabel(providerName: ProviderName): string {
  try {
    return getProviderMeta(providerName).label;
  } catch {
    return userMessage('assistant.provider');
  }
}
