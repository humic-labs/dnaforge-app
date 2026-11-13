import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CliModelPicker } from './CliModelPicker';

let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 400,
    bottom: 420,
    left: 100,
    right: 200,
    width: 100,
    height: 20,
    x: 100,
    y: 400,
    toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => rectSpy?.mockRestore());

describe('CliModelPicker dropdown portal', () => {
  function renderInClip() {
    return render(
      <div data-testid="clip" style={{ overflow: 'hidden', width: 120, height: 40 }}>
        <CliModelPicker
          transport="claude-agent-sdk"
          model={null}
          onModelChange={vi.fn()}
          selectTestId="cli-model-select"
          customInputTestId="cli-model-custom"
          selectClassName=""
          customInputClassName=""
        />
      </div>
    );
  }

  it('mounts the open menu under document.body, escaping the overflow-hidden ancestor', () => {
    renderInClip();
    expect(screen.queryByTestId('cli-model-select-menu')).toBeNull();

    fireEvent.click(screen.getByTestId('cli-model-select'));

    const menu = screen.getByTestId('cli-model-select-menu');
    const clip = screen.getByTestId('clip');
    expect(clip.contains(menu)).toBe(false);
    expect(menu.closest('[data-testid="clip"]')).toBeNull();
    expect(document.body.contains(menu)).toBe(true);
  });

  it('renders a catalog option that commits the model and closes the menu', () => {
    const onModelChange = vi.fn();
    render(
      <CliModelPicker
        transport="claude-agent-sdk"
        model={null}
        onModelChange={onModelChange}
        selectTestId="cli-model-select"
        customInputTestId="cli-model-custom"
        selectClassName=""
        customInputClassName=""
      />
    );
    fireEvent.click(screen.getByTestId('cli-model-select'));
    fireEvent.click(screen.getByTestId('cli-model-select-option-__custom_cli_model__'));
    expect(screen.queryByTestId('cli-model-select-menu')).toBeNull();
    expect(screen.getByTestId('cli-model-custom')).toBeInTheDocument();
  });

  it('warns when the saved selection equals a configured default absent from the account catalog', () => {
    render(
      <CliModelPicker
        transport="codex-sdk"
        model="stale-default"
        defaultModel="stale-default"
        availableModels={[]}
        onModelChange={vi.fn()}
        selectTestId="stale-default-select"
        customInputTestId="stale-default-input"
      />
    );
    expect(screen.getByTestId('stale-default-select-model-error')).toHaveTextContent(
      'Choose an available model'
    );
  });

  it('keeps a stale saved Codex override visible until the user chooses a compatible model', () => {
    render(
      <CliModelPicker
        transport="codex-sdk"
        model="gpt-5-codex"
        codexAuthMode="chatgpt"
        onModelChange={vi.fn()}
        selectTestId="codex-model-select"
        customInputTestId="codex-model-custom"
        selectClassName=""
        customInputClassName=""
      />
    );

    fireEvent.click(screen.getByTestId('codex-model-select'));
    expect(screen.queryByText('GPT-5 Codex')).toBeNull();
    expect(screen.queryByText('GPT-5')).toBeNull();
    expect(screen.queryByText('o3')).toBeNull();
    expect(screen.getByDisplayValue('gpt-5-codex')).toBeInTheDocument();
    expect(screen.getByTestId('codex-model-select-model-error')).toHaveTextContent(
      'Choose an available model'
    );
    expect(screen.getByTestId('codex-model-select-option-__cli_default__')).toBeInTheDocument();
    expect(
      screen.getByTestId('codex-model-select-option-__custom_cli_model__')
    ).toBeInTheDocument();
  });

  it('refreshes account-bound choices without silently changing the stored model', () => {
    const onModelChange = vi.fn();
    const onRefreshModels = vi.fn();
    render(
      <CliModelPicker
        transport="codex-sdk"
        model={null}
        onModelChange={onModelChange}
        onRefreshModels={onRefreshModels}
        selectTestId="refresh-models"
        customInputTestId="refresh-custom"
        selectClassName=""
        customInputClassName=""
      />
    );
    fireEvent.click(screen.getByTestId('refresh-models'));
    fireEvent.click(screen.getByRole('option', { name: 'Refresh model choices' }));
    expect(onRefreshModels).toHaveBeenCalledOnce();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('renders every model returned by the live Codex catalog', () => {
    render(
      <CliModelPicker
        transport="codex-sdk"
        model={null}
        codexAuthMode="chatgpt"
        availableModels={[
          { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', reasoningEfforts: ['high'] },
          { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', reasoningEfforts: ['low'] },
          { id: 'gpt-5.5', displayName: 'GPT-5.5', reasoningEfforts: ['medium'] },
        ]}
        onModelChange={vi.fn()}
        selectTestId="codex-live-model-select"
        customInputTestId="codex-live-model-custom"
        selectClassName=""
        customInputClassName=""
      />
    );

    fireEvent.click(screen.getByTestId('codex-live-model-select'));
    expect(screen.getByRole('option', { name: 'GPT-6 Astra' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.6 Sol' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'GPT-5.5' })).toBeInTheDocument();
  });
});

describe('CliModelPicker in Settings', () => {
  it('uses the shared combobox and commits a catalog model by keyboard', () => {
    const onModelChange = vi.fn();
    render(
      <CliModelPicker
        transport="codex-sdk"
        model={null}
        defaultModel="gpt-6-sol"
        availableModels={[
          { id: 'gpt-6-sol', displayName: 'GPT-6 Sol' },
          { id: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
        ]}
        onModelChange={onModelChange}
        selectTestId="settings-model"
        customInputTestId="settings-custom-model"
        appearance="settings"
      />
    );
    const trigger = screen.getByRole('combobox', { name: 'Codex CLI model' });
    expect(trigger).toHaveAttribute('data-settings-control', 'select');
    expect(trigger).toHaveTextContent('GPT-6 Sol');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onModelChange).toHaveBeenCalledWith('codex-sdk', 'gpt-6-astra');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps custom model editing and returning to shared choices in Settings', () => {
    const onModelChange = vi.fn();
    render(
      <CliModelPicker
        transport="grok-acp"
        model={null}
        onModelChange={onModelChange}
        selectTestId="settings-grok-model"
        customInputTestId="settings-grok-custom-model"
        customInputPlacement="replace-select"
        appearance="settings"
      />
    );
    const trigger = screen.getByRole('combobox', { name: 'Grok Build model' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Custom model...' }));
    const input = screen.getByTestId('settings-grok-custom-model');
    fireEvent.change(input, { target: { value: 'custom-grok' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onModelChange).toHaveBeenCalledWith('grok-acp', 'custom-grok');
    fireEvent.click(screen.getByRole('button', { name: 'Show Grok Build model choices' }));
    expect(screen.getByRole('combobox', { name: 'Grok Build model' })).toHaveAttribute(
      'data-settings-control',
      'select'
    );
  });
});
