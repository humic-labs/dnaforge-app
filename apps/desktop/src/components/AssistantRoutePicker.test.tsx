import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantRoutePicker } from './AssistantRoutePicker';
import { DEFAULT_ASSISTANT_HOST_DESCRIPTORS } from '../features/ai/assistant-hosts';
import {
  buildAssistantRouteOptions,
  type AssistantRouteState,
} from '../features/ai/assistant-routes';

const readyState = {
  assistantRoute: { kind: 'cli', transport: 'codex-sdk' },
  provider: 'openai',
  model: 'gpt-4o-mini',
  agentTransport: 'codex-sdk',
  providerStatuses: {
    openai: { isConfigured: true },
    anthropic: { isConfigured: false },
    google: { isConfigured: false },
    deepseek: { isConfigured: false },
    xai: { isConfigured: false },
  },
  providerModels: {},
  cliModelSettings: {},
  agentDetection: {
    'codex-sdk': { status: 'ready' },
    'claude-code': { status: 'ready' },
  },
  hostedRouteReadiness: 'ready',
} as unknown as AssistantRouteState;

function renderPicker(
  options: ReturnType<typeof buildAssistantRouteOptions>,
  callbacks: {
    onSelect?: ReturnType<typeof vi.fn>;
    onHostedSignInRequired?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const onSelect = callbacks.onSelect ?? vi.fn();
  const onHostedSignInRequired = callbacks.onHostedSignInRequired ?? vi.fn();
  render(
    <AssistantRoutePicker
      activeRoute={{ kind: 'cli', transport: 'codex-sdk', permissionMode: 'native-cli' }}
      options={options}
      isConfigured
      onSelect={onSelect}
      onHostedSignInRequired={onHostedSignInRequired}
      onManageSources={vi.fn()}
      buttonTestId="route-button"
      menuTestId="route-menu"
      optionTestIdPrefix="route-option"
      buttonClassName=""
      menuClassName=""
    />
  );
  fireEvent.click(screen.getByTestId('route-button'));
  return { onSelect, onHostedSignInRequired };
}

describe('AssistantRoutePicker reachability', () => {
  it('renders EVERY option it is given, regardless of category', () => {
    const options = buildAssistantRouteOptions(readyState);
    expect(options.length).toBeGreaterThan(0);
    renderPicker(options);

    for (const option of options) {
      expect(
        screen.queryByTestId(`route-option-${option.id}`),
        `option "${option.id}" (category "${option.category}") was dropped by the picker`
      ).not.toBeNull();
    }
  });

  it('offers every registered host descriptor, so a built route is never unreachable', () => {
    renderPicker(buildAssistantRouteOptions(readyState));

    for (const descriptor of DEFAULT_ASSISTANT_HOST_DESCRIPTORS) {
      expect(
        screen.queryByTestId(`route-option-${descriptor.id}`),
        `descriptor "${descriptor.id}" is registered but has no selectable option`
      ).not.toBeNull();
    }
  });

  it('offers the hosted tiers even when the gateway is not ready', () => {
    const options = buildAssistantRouteOptions({
      ...readyState,
      hostedRouteReadiness: 'needs-login',
    } as AssistantRouteState);
    renderPicker(options);

    expect(screen.queryByTestId('route-option-dnaforge-hosted-auto')).not.toBeNull();
    expect(screen.queryByTestId('route-option-dnaforge-hosted-deep')).not.toBeNull();
  });

  it('does not let an executor-less route become a selectable active route', () => {
    const [existing] = buildAssistantRouteOptions(readyState);
    if (!existing) throw new Error('expected at least one built-in route option');
    const unavailable = {
      ...existing,
      id: 'future-router',
      hostId: 'future-router',
      selection: { kind: 'orchestrator' as const, id: 'future-router' },
      configured: false,
      active: false,
      readiness: 'unavailable' as const,
      readinessLabel: 'Unavailable',
    };
    const { onSelect } = renderPicker([unavailable]);
    const option = screen.getByTestId('route-option-future-router');

    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('requests sign-in instead of selecting a signed-out Hosted route', () => {
    const options = buildAssistantRouteOptions({
      ...readyState,
      hostedRouteReadiness: 'needs-login',
    } as AssistantRouteState);
    const callbacks = renderPicker(options);

    fireEvent.click(screen.getByTestId('route-option-dnaforge-hosted-auto'));

    expect(callbacks.onHostedSignInRequired).toHaveBeenCalledTimes(1);
    expect(callbacks.onHostedSignInRequired).toHaveBeenCalledWith({
      kind: 'hosted',
      tier: 'auto',
    });
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('route-menu')).not.toBeInTheDocument();
  });

  it('does not select or request sign-in for a real Hosted outage', () => {
    const options = buildAssistantRouteOptions({
      ...readyState,
      hostedRouteReadiness: 'gateway-unavailable',
    } as AssistantRouteState);
    const callbacks = renderPicker(options);

    fireEvent.click(screen.getByTestId('route-option-dnaforge-hosted-auto'));

    expect(callbacks.onHostedSignInRequired).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
