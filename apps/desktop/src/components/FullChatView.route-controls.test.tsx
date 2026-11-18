import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeAgentActivityMessage,
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
  useDestructiveConfirmStore,
} from './FullChatView.test-harness';

const {
  mockAgentSdkAuthenticate,
  mockAgentCapabilitiesDiscover,
  mockAgentCapabilitiesResolve,
  mockAISettingsState,
  mockChatState,
  mockRefreshAgentDetection,
  mockSetAssistantRoute,
  mockSetCliModel,
  mockSetCliReasoningEffort,
  mockSetModel,
} = getFullChatViewHarness();

const codexSkill = {
  id: 'codex-sdk:skill:tdd',
  provider: 'codex-sdk' as const,
  nativeId: 'tdd',
  kind: 'skill' as const,
  label: 'tdd',
  description: 'Test first.',
  scope: 'workspace' as const,
  effects: ['instructions' as const, 'filesystem-read' as const],
  availability: { state: 'supported' as const },
  stages: {
    advertised: true,
    discoverable: true,
    invocable: true,
    visible: true,
    deterministic: true,
    liveQualified: false,
  },
};

const codexMemory = {
  id: 'codex-sdk:memory:memory-1',
  provider: 'codex-sdk' as const,
  nativeId: 'memory-1',
  kind: 'memory' as const,
  label: 'Current organism',
  description: 'Attach this DNAForge workspace memory to one turn.',
  scope: 'workspace' as const,
  effects: ['instructions' as const],
  availability: { state: 'supported' as const },
  stages: {
    advertised: true,
    discoverable: true,
    invocable: true,
    visible: true,
    deterministic: true,
    liveQualified: false,
  },
  source: 'dnaforge-memory:memory-1',
};

function expectComposerPickerDisclosureIcon(button: HTMLElement) {
  const icon = button.querySelector('.wp-menu-caret')!;
  expect(icon).toHaveAttribute('data-direction', 'down');
  expect(icon).toHaveAttribute('width', '12');
  expect(icon).toHaveAttribute('height', '12');
  expect(icon.querySelector('path')).toHaveAttribute('stroke-width', '1.5');
  for (const className of ['justify-between', 'w-28', 'w-36', 'w-44']) {
    expect(button).not.toHaveClass(className);
  }
  return icon;
}

function expectElementBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

function openAgentActions(): void {
  fireEvent.click(screen.getByTestId('chat-cli-secondary-options'));
  fireEvent.click(screen.getByTestId('agent-actions-button'));
}

describe('FullChatView route controls', () => {
  beforeEach(resetFullChatViewHarness);

  it('shows separate model and assistant source controls in the empty-state composer toolbar', () => {
    mockAISettingsState.providerModels.openai = {
      ...mockAISettingsState.providerModels.openai,
      fetchStatus: 'success',
      fetchError: null,
      models: ['gpt-4o', 'gpt-4o-mini'],
    };

    render(<FullChatView workspacePath="/workspace" />);

    const composer = screen.getByTestId('chat-composer');
    const inputRow = within(composer).getByTestId('chat-composer-input-row');
    const toolbar = within(composer).getByTestId('chat-composer-toolbar');
    expect(composer).toHaveClass('bg-bg-muted/70', 'dark:bg-bg-muted');
    expect(composer).not.toHaveClass('bg-accent-subtle/80', 'dark:bg-accent-subtle/65');
    expect(within(inputRow).getByTestId('ai-input')).toHaveClass('min-h-[52px]');
    expect(within(inputRow).queryByTestId('model-selector-button')).not.toBeInTheDocument();
    expect(within(inputRow).queryByTestId('chat-attach-button')).not.toBeInTheDocument();
    expect(within(toolbar).getByTestId('chat-attach-button')).toBeInTheDocument();

    const modelSelect = within(toolbar).getByTestId('chat-model-version-select');
    expect(modelSelect).toHaveAttribute('data-value', 'gpt-4o');
    expect(modelSelect).toHaveAccessibleName('OpenAI model');
    expect(modelSelect).toHaveClass('wp-menu-trigger');
    expect(modelSelect).toHaveAttribute('data-variant', 'toolbar');
    expect(modelSelect).not.toHaveClass('border');
    expect(modelSelect).not.toHaveClass('bg-bg');
    expectComposerPickerDisclosureIcon(modelSelect);
    fireEvent.click(modelSelect);
    expect(document.body.contains(screen.getByTestId('chat-model-version-select-menu'))).toBe(true);
    expect(screen.getByTestId('chat-model-version-select-menu')).toHaveStyle({ position: 'fixed' });
    fireEvent.click(screen.getByTestId('chat-model-version-select-option-gpt-4o-mini'));
    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });

    const routeButton = within(toolbar).getByTestId('model-selector-button');
    expect(routeButton).toHaveAccessibleName('Run with: Direct API');
    expect(routeButton).toHaveAttribute(
      'title',
      expect.stringContaining('Direct API / OpenAI API')
    );
    expect(routeButton).not.toHaveClass('border');
    expectComposerPickerDisclosureIcon(routeButton);
    expectElementBefore(routeButton, modelSelect);
    expect(within(toolbar).queryByTestId('chat-cli-permission-status')).not.toBeInTheDocument();

    fireEvent.click(routeButton);

    const menu = screen.getByTestId('chat-assistant-route-menu');
    expect(menu).toHaveTextContent('Run with');
    expect(menu).not.toHaveTextContent('Assistant route');
    expect(menu).not.toHaveTextContent('Provider routes use DNAForge-stored API keys');
    expect(menu).not.toHaveTextContent('DNAForge grants only govern app tools');
    expect(within(menu).getByTestId('chat-assistant-route-option-direct-api')).toHaveTextContent(
      'Direct API'
    );
    expect(within(menu).getByTestId('chat-assistant-route-option-direct-api')).toHaveTextContent(
      'OpenAI API'
    );
    expect(within(menu).getByTestId('chat-assistant-route-option-codex-cli')).toBeInTheDocument();
    expect(within(menu).getByTestId('chat-assistant-route-option-claude-code')).toBeInTheDocument();
    expect(
      within(menu).queryByTestId('chat-assistant-route-option-provider:openai:gpt-4o-mini')
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByTestId('chat-assistant-route-option-setting-provider:openai:gpt-4o-mini')
    ).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByTestId('chat-assistant-route-option-direct-api'));

    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('opens host settings from the chat picker configure buttons without switching routes', () => {
    const onConfigureHost = vi.fn();
    render(<FullChatView workspacePath="/workspace" onConfigureHost={onConfigureHost} />);

    fireEvent.click(screen.getByTestId('model-selector-button'));
    const menu = screen.getByTestId('chat-assistant-route-menu');

    expect(menu).not.toHaveTextContent('Using');
    expect(menu).not.toHaveTextContent('Source');
    expect(menu).not.toHaveTextContent('Mode');
    expect(menu).not.toHaveTextContent('App-supervised tools');
    expect(
      within(menu).getByTestId('chat-assistant-route-option-direct-api-configure')
    ).toHaveAttribute('aria-label', 'Configure Direct API');
    expect(
      within(menu).getByTestId('chat-assistant-route-option-codex-cli-configure')
    ).toHaveAttribute('aria-label', 'Configure Codex CLI');
    expect(
      within(menu).getByTestId('chat-assistant-route-option-claude-code-configure')
    ).toHaveAttribute('aria-label', 'Configure Claude Code');

    fireEvent.click(within(menu).getByTestId('chat-assistant-route-option-direct-api-configure'));

    expect(onConfigureHost).toHaveBeenCalledWith('direct-api');
    expect(mockSetAssistantRoute).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-assistant-route-menu')).not.toBeInTheDocument();
  });

  it('does not nest provider model controls inside the host picker', () => {
    mockAISettingsState.providerModels.openai = {
      ...mockAISettingsState.providerModels.openai,
      fetchStatus: 'success',
      fetchError: null,
      models: ['gpt-4o', 'gpt-4o-mini'],
    };

    render(<FullChatView workspacePath="/workspace" />);

    fireEvent.click(screen.getByTestId('model-selector-button'));
    const menu = screen.getByTestId('chat-assistant-route-menu');
    expect(menu).not.toHaveTextContent('OpenAI Models');
    expect(
      within(menu).queryByTestId('chat-assistant-route-option-setting-provider:openai:gpt-4o-mini')
    ).not.toBeInTheDocument();
  });

  it('switches Claude Code directly from the chat route picker', () => {
    render(<FullChatView workspacePath="/workspace" />);

    fireEvent.click(screen.getByTestId('model-selector-button'));
    fireEvent.click(
      within(screen.getByTestId('chat-assistant-route-menu')).getByTestId(
        'chat-assistant-route-option-claude-code'
      )
    );

    expect(mockSetAssistantRoute).toHaveBeenCalledWith({
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    });
  });

  it('keeps CLI permission mode out of the composer and host picker', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.queryByTestId('chat-cli-permission-status')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('model-selector-button'));
    const menu = screen.getByTestId('chat-assistant-route-menu');
    expect(menu).not.toHaveTextContent('Local CLI tools');
    expect(menu).not.toHaveTextContent('Local CLI login');
    expect(menu).not.toHaveTextContent('App-supervised tools');
  });

  it('keeps skills automatic while Agent Actions can stage an explicit memory', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAgentCapabilitiesDiscover.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: 'snapshot-codex',
      provider: 'codex-sdk',
      providerVersion: 'codex 1',
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: 1,
      controls: [codexSkill, codexMemory],
    });
    mockAgentCapabilitiesResolve.mockResolvedValue({ ok: true, control: codexMemory });

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.queryByTestId('agent-actions-button')).not.toBeInTheDocument();
    openAgentActions();
    expect(screen.queryByText('tdd')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Current organism/i }));
    const input = screen.getByTestId('ai-input');
    await waitFor(() =>
      expect(screen.getByTestId('staged-agent-capability')).toHaveTextContent('Current organism')
    );
    expect(input).toHaveValue('');
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove selected agent action: Current organism' })
    );
    expect(screen.queryByTestId('staged-agent-capability')).not.toBeInTheDocument();

    openAgentActions();
    fireEvent.click(await screen.findByRole('button', { name: /Current organism/i }));
    await waitFor(() =>
      expect(screen.getByTestId('staged-agent-capability')).toHaveTextContent('Current organism')
    );
    fireEvent.change(input, { target: { value: 'implement the parser' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => expect(mockChatState.sendMessage).toHaveBeenCalledOnce());
    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      'implement the parser',
      '/workspace',
      undefined,
      [],
      expect.objectContaining({
        capabilitySelection: {
          snapshotId: 'snapshot-codex',
          provider: 'codex-sdk',
          capabilityId: codexMemory.id,
        },
      })
    );

    fireEvent.change(input, { target: { value: '/' } });
    expect(await screen.findByRole('dialog', { name: 'Agent actions' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close agent actions' }));
    expect(input).toHaveValue('');
  });

  it('clears history and Actions before opening extension settings', async () => {
    const onOpenAssistantSources = vi.fn();
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAgentCapabilitiesDiscover.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: 'snapshot-codex',
      provider: 'codex-sdk',
      providerVersion: 'codex 1',
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: 1,
      controls: [codexSkill],
    });

    render(
      <FullChatView workspacePath="/workspace" onOpenAssistantSources={onOpenAssistantSources} />
    );

    fireEvent.click(screen.getByTestId('ai-history-button'));
    expect(screen.getByTestId('ai-history-panel')).toBeInTheDocument();
    openAgentActions();
    expect(await screen.findByRole('dialog', { name: 'Agent actions' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage agent extensions' }));

    expect(onOpenAssistantSources).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('agent-actions-backdrop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
  });

  it('stages memory visibly without rewriting the user question', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAgentCapabilitiesDiscover.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: 'snapshot-codex',
      provider: 'codex-sdk',
      providerVersion: 'codex 1',
      accountFingerprint: 'account-a',
      workspaceFingerprint: 'workspace-a',
      capturedAt: 1,
      controls: [codexMemory],
    });
    mockAgentCapabilitiesResolve.mockResolvedValue({ ok: true, control: codexMemory });
    render(<FullChatView workspacePath="/workspace" />);

    openAgentActions();
    fireEvent.click(await screen.findByRole('button', { name: /current organism/i }));
    await waitFor(() =>
      expect(screen.getByTestId('staged-agent-capability')).toHaveTextContent('Current organism')
    );
    const input = screen.getByTestId('ai-input');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'Which growth medium should I use?' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => expect(mockChatState.sendMessage).toHaveBeenCalledOnce());
    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      'Which growth medium should I use?',
      '/workspace',
      undefined,
      [],
      expect.objectContaining({
        capabilitySelection: {
          snapshotId: 'snapshot-codex',
          provider: 'codex-sdk',
          capabilityId: codexMemory.id,
        },
      })
    );
  });

  it('lets the active CLI model override and reasoning effort be changed from the chat composer', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAISettingsState.agentDetection = {
      ...mockAISettingsState.agentDetection,
      codex: {
        ...mockAISettingsState.agentDetection.codex,
        authMode: 'apikey',
        models: [
          {
            id: 'gpt-5-codex',
            displayName: 'GPT-5 Codex',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            isDefault: true,
          },
          {
            id: 'gpt-5',
            displayName: 'GPT-5',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          },
        ],
        modelCatalog: {
          ...mockAISettingsState.agentDetection.codex.modelCatalog!,
          observedModelCount: 2,
        },
      },
    };
    mockAISettingsState.cliModelSettings = {
      'codex-sdk': { model: 'gpt-5-codex', reasoningEffort: 'high' },
      'claude-agent-sdk': { model: null, reasoningEffort: null },
    };

    render(<FullChatView workspacePath="/workspace" />);

    const modelSelect = screen.getByTestId('chat-cli-model-select');
    const effortSelect = screen.getByTestId('chat-cli-effort-select');

    expect(modelSelect).toHaveAttribute('data-value', 'gpt-5-codex');
    expect(modelSelect).not.toHaveClass('font-mono');
    expect(modelSelect).not.toHaveClass('bg-bg');
    const modelIcon = expectComposerPickerDisclosureIcon(modelSelect);
    expect(effortSelect).toHaveAttribute('data-value', 'high');
    expect(effortSelect).not.toHaveClass('bg-bg');
    const effortIcon = expectComposerPickerDisclosureIcon(effortSelect);
    expect(effortIcon.getAttribute('class')).toBe(modelIcon.getAttribute('class'));
    expectElementBefore(screen.getByTestId('model-selector-button'), modelSelect);
    expectElementBefore(modelSelect, effortSelect);

    fireEvent.click(modelSelect);
    expect(document.body.contains(screen.getByTestId('chat-cli-model-select-menu'))).toBe(true);
    expect(screen.getByTestId('chat-cli-model-select-menu')).toHaveStyle({ position: 'fixed' });
    fireEvent.click(screen.getByTestId('chat-cli-model-select-option-gpt-5'));
    expect(mockSetCliModel).toHaveBeenCalledWith('codex-sdk', 'gpt-5');

    fireEvent.click(effortSelect);
    expect(document.body.contains(screen.getByTestId('chat-cli-effort-select-menu'))).toBe(true);
    expect(screen.getByTestId('chat-cli-effort-select-menu')).toHaveStyle({ position: 'fixed' });
    fireEvent.click(screen.getByTestId('chat-cli-effort-select-option-xhigh'));
    expect(mockSetCliReasoningEffort).toHaveBeenCalledWith('codex-sdk', 'xhigh');
  });

  it('keeps a custom CLI model as an explicit escape hatch from the composer picker', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAISettingsState.cliModelSettings = {
      'codex-sdk': { model: null, reasoningEffort: 'high' },
      'claude-agent-sdk': { model: null, reasoningEffort: null },
    };

    render(<FullChatView workspacePath="/workspace" />);

    fireEvent.click(screen.getByTestId('chat-cli-model-select'));
    fireEvent.click(screen.getByTestId('chat-cli-model-select-option-__custom_cli_model__'));

    const customInput = screen.getByTestId('chat-cli-model-custom-input') as HTMLInputElement;
    expect(screen.getByTestId('chat-cli-model-custom-input-picker-button')).toHaveAccessibleName(
      'Show Codex CLI model choices'
    );
    expect(screen.queryByTestId('chat-cli-model-select')).not.toBeInTheDocument();
    fireEvent.change(customInput, { target: { value: 'gpt-5-codex-mini' } });
    fireEvent.blur(customInput);

    expect(mockSetCliModel).toHaveBeenCalledWith('codex-sdk', 'gpt-5-codex-mini');
  });

  it('resolves old null CLI effort state to a concrete selected effort', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'claude-agent-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'claude-agent-sdk';
    mockAISettingsState.cliModelSettings = {
      'codex-sdk': { model: null, reasoningEffort: null },
      'claude-agent-sdk': { model: 'claude-opus-4', reasoningEffort: null },
    };

    render(<FullChatView workspacePath="/workspace" />);

    const customInput = screen.getByTestId('chat-cli-model-custom-input') as HTMLInputElement;
    const effortSelect = screen.getByTestId('chat-cli-effort-select');

    expect(screen.queryByTestId('chat-cli-model-select')).not.toBeInTheDocument();
    expect(customInput.value).toBe('claude-opus-4');
    expect(effortSelect).toHaveAttribute('data-value', 'high');

    fireEvent.click(screen.getByTestId('chat-cli-model-custom-input-picker-button'));
    expect(screen.getByTestId('chat-cli-model-select')).toHaveAttribute(
      'data-value',
      '__custom_cli_model__'
    );

    fireEvent.click(screen.getByTestId('chat-cli-model-select'));
    fireEvent.click(screen.getByTestId('chat-cli-model-select-option-__custom_cli_model__'));
    const reopenedCustomInput = screen.getByTestId('chat-cli-model-custom-input');
    fireEvent.change(reopenedCustomInput, { target: { value: '   ' } });
    fireEvent.blur(reopenedCustomInput);
    expect(mockSetCliModel).toHaveBeenCalledWith('claude-agent-sdk', null);

    fireEvent.click(effortSelect);
    const effortOptions = within(screen.getByTestId('chat-cli-effort-select-menu')).getAllByRole(
      'option'
    );
    expect(effortOptions.map((option) => option.getAttribute('data-testid'))).not.toContain(
      'chat-cli-effort-select-option-'
    );
    fireEvent.click(screen.getByTestId('chat-cli-effort-select-option-max'));
    expect(mockSetCliReasoningEffort).toHaveBeenCalledWith('claude-agent-sdk', 'max');
  });

  it('keeps assistant controls in the composer toolbar for active chat tabs', () => {
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Question', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Answer', createdAt: 2 },
    ];

    render(<FullChatView workspacePath="/workspace" />);

    const composer = screen.getByTestId('chat-composer');
    const inputRow = within(composer).getByTestId('chat-composer-input-row');
    const toolbar = within(composer).getByTestId('chat-composer-toolbar');

    expect(within(inputRow).getByTestId('ai-input')).toHaveClass('w-full');
    expect(within(inputRow).queryByTestId('model-selector-button')).not.toBeInTheDocument();
    expect(within(toolbar).getByTestId('chat-attach-button')).toBeInTheDocument();
    expect(within(toolbar).getByTestId('chat-model-version-select')).toHaveAttribute(
      'data-value',
      'gpt-4o'
    );
    expect(within(toolbar).getByTestId('model-selector-button')).toHaveAccessibleName(
      'Run with: Direct API'
    );
  });

  it('opens the Connect-AI modal in place (no Settings detour) when the active provider needs a key', () => {
    const onConfigureHost = vi.fn();
    const onOpenAssistantSources = vi.fn();
    mockAISettingsState.isConfigured = false;
    mockAISettingsState.provider = 'openai';
    mockAISettingsState.model = 'gpt-4o';
    mockAISettingsState.assistantRoute = {
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    };
    mockAISettingsState.providerStatuses = {
      anthropic: { isConfigured: false },
      openai: { isConfigured: false },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    };
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Previous question', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Previous answer', createdAt: 2 },
    ];
    mockChatState.isLoading = true;

    render(
      <FullChatView
        workspacePath="/workspace"
        onConfigureHost={onConfigureHost}
        onOpenAssistantSources={onOpenAssistantSources}
      />
    );

    expect(screen.getByText('Previous answer')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('ai-input'), {
      target: { value: 'Do not lose this draft' },
    });
    expect(screen.getByTestId('chat-send-button')).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('ai-input'), { key: 'Enter' });
    expect(mockChatState.sendMessage).not.toHaveBeenCalled();

    const connectButton = screen.getByTestId('chat-direct-api-key-warning');
    expect(connectButton).toHaveTextContent('Add API key');
    fireEvent.click(connectButton);

    expect(screen.getByTestId('connect-ai-modal')).toBeInTheDocument();
    expect(onConfigureHost).not.toHaveBeenCalled();
    expect(onOpenAssistantSources).not.toHaveBeenCalled();
    expect(mockChatState.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-input')).toHaveValue('Do not lose this draft');
  });

  it('keeps chat history visible and blocks sends when the active CLI host needs login', async () => {
    const onConfigureHost = vi.fn();
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAISettingsState.agentDetection = {
      ...mockAISettingsState.agentDetection,
      codex: {
        ...mockAISettingsState.agentDetection.codex,
        cli: 'installed',
        path: '/usr/local/bin/codex',
        auth: 'unauthenticated',
        defaultModel: 'gpt-5.5',
        authMode: null,
        authFilePresent: false,
      },
    };
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Previous CLI question', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Previous CLI answer', createdAt: 2 },
    ];

    render(<FullChatView workspacePath="/workspace" onConfigureHost={onConfigureHost} />);

    expect(screen.getByText('Previous CLI answer')).toBeInTheDocument();
    expect(screen.getByTestId('model-selector-button')).toHaveTextContent('Codex CLI');
    const modelSelect = screen.getByTestId('chat-cli-model-select');
    expect(modelSelect).toHaveAttribute('data-value', '__cli_default__');
    expect(modelSelect).toHaveTextContent('GPT-5.5');
    expect(screen.getByTestId('chat-cli-effort-select')).toHaveAttribute('data-value', 'high');
    fireEvent.click(modelSelect);
    expect(screen.getByTestId('chat-cli-model-select-option-__cli_default__')).toHaveTextContent(
      'GPT-5.5 (default)'
    );
    expect(screen.getByTestId('model-selector-button')).toHaveAttribute(
      'title',
      expect.stringContaining('Needs login')
    );
    expect(screen.getByTestId('chat-cli-login-warning')).toHaveTextContent('Authenticate');
    expect(screen.getByTestId('chat-cli-login-warning')).toHaveAttribute(
      'aria-label',
      'Authenticate CLI host'
    );

    fireEvent.change(screen.getByTestId('ai-input'), {
      target: { value: 'Do not send before login' },
    });
    expect(screen.getByTestId('chat-send-button')).toBeDisabled();
    expect(screen.getByTestId('ai-input')).toHaveValue('Do not send before login');

    fireEvent.click(screen.getByTestId('chat-cli-login-warning'));

    await waitFor(() => {
      expect(mockAgentSdkAuthenticate).toHaveBeenCalledWith(
        'codex-sdk',
        expect.objectContaining({
          authId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          ),
        })
      );
    });
    expect(onConfigureHost).not.toHaveBeenCalled();
    expect(mockRefreshAgentDetection).toHaveBeenCalled();
    expect(mockAgentSdkAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockChatState.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-input')).toHaveValue('Do not send before login');
  });

  it('shows a neutral "Checking" status (not "Authenticate") while CLI detection is in flight, without blocking send', () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    mockAISettingsState.agentDetection =
      null as unknown as typeof mockAISettingsState.agentDetection;

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByTestId('chat-route-checking-status')).toHaveTextContent('Checking CLI');
    expect(screen.queryByTestId('chat-cli-login-warning')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'hello' } });
    expect(screen.getByTestId('chat-send-button')).not.toBeDisabled();
  });
});
