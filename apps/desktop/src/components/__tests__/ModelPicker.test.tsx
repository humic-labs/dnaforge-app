import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ModelPicker, ModelTextInput } from '../SettingsPanel';
import type { ProviderModelState, ProviderStatus } from '../../features/ai/settings';

beforeEach(() => {
  cleanup();
});

describe('ModelPicker', () => {
  const defaultProps = {
    model: 'gpt-4o',
    defaultModel: 'gpt-4o',
    onModelChange: vi.fn(),
    onRetryFetch: vi.fn(),
  };

  it('shows disabled placeholder when not configured', () => {
    const status: ProviderStatus = { isConfigured: false, keySource: 'none' };
    const modelState: ProviderModelState = { models: [], fetchStatus: 'idle', fetchError: null };

    render(<ModelPicker {...defaultProps} status={status} modelState={modelState} />);

    const select = screen.getByTestId('model-input') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent('Enter API key to see models');
  });

  it('shows loading select when fetchStatus=loading', () => {
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = { models: [], fetchStatus: 'loading', fetchError: null };

    render(<ModelPicker {...defaultProps} status={status} modelState={modelState} />);

    const select = screen.getByTestId('model-input');
    expect(select).toBeDisabled();
    expect(select).toHaveTextContent('Loading models…');
  });

  it('shows error + retry + text input when fetchStatus=error', () => {
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = {
      models: [],
      fetchStatus: 'error',
      fetchError: 'OpenAI API error: 401 Unauthorized',
    };

    render(<ModelPicker {...defaultProps} status={status} modelState={modelState} />);

    expect(screen.getByText('OpenAI API error: 401 Unauthorized')).toBeInTheDocument();
    expect(screen.getByTestId('model-retry-button')).toBeInTheDocument();
    expect(screen.getByTestId('model-input')).toBeInTheDocument();
    expect((screen.getByTestId('model-input') as HTMLInputElement).type).toBe('text');
  });

  it('calls onRetryFetch when retry button clicked', () => {
    const onRetryFetch = vi.fn();
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = {
      models: [],
      fetchStatus: 'error',
      fetchError: 'Error',
    };

    render(
      <ModelPicker
        {...defaultProps}
        status={status}
        modelState={modelState}
        onRetryFetch={onRetryFetch}
      />
    );

    fireEvent.click(screen.getByTestId('model-retry-button'));
    expect(onRetryFetch).toHaveBeenCalledOnce();
  });

  it('shows populated select when success + models', () => {
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = {
      models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'],
      fetchStatus: 'success',
      fetchError: null,
    };

    render(<ModelPicker {...defaultProps} status={status} modelState={modelState} />);

    const select = screen.getByTestId('model-input');
    expect(select).not.toBeDisabled();
    expect(select).toHaveAttribute('data-value', 'gpt-4o');

    fireEvent.click(select);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('gpt-4o');
    expect(options[1]).toHaveTextContent('gpt-4o-mini');
    expect(options[2]).toHaveTextContent('o1-preview');
  });

  it('calls onModelChange when select value changes', () => {
    const onModelChange = vi.fn();
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = {
      models: ['gpt-4o', 'gpt-4o-mini'],
      fetchStatus: 'success',
      fetchError: null,
    };

    render(
      <ModelPicker
        {...defaultProps}
        status={status}
        modelState={modelState}
        onModelChange={onModelChange}
      />
    );

    fireEvent.click(screen.getByTestId('model-input'));
    fireEvent.click(screen.getByRole('option', { name: 'gpt-4o-mini' }));
    expect(onModelChange).toHaveBeenCalledWith('gpt-4o-mini');
  });

  it('shows "No models returned" + text input when success + empty', () => {
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = {
      models: [],
      fetchStatus: 'success',
      fetchError: null,
    };

    render(<ModelPicker {...defaultProps} status={status} modelState={modelState} />);

    expect(screen.getByText('No models returned')).toBeInTheDocument();
    expect(screen.getByTestId('model-input')).toBeInTheDocument();
    expect((screen.getByTestId('model-input') as HTMLInputElement).type).toBe('text');
  });

  it('shows text input fallback when idle', () => {
    const status: ProviderStatus = { isConfigured: true, keySource: 'keyring' };
    const modelState: ProviderModelState = { models: [], fetchStatus: 'idle', fetchError: null };

    render(<ModelPicker {...defaultProps} status={status} modelState={modelState} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('gpt-4o');
  });
});

describe('ModelTextInput', () => {
  it('initializes draft from model prop', () => {
    render(<ModelTextInput model="gpt-4o" defaultModel="gpt-4o" onModelChange={vi.fn()} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    expect(input.value).toBe('gpt-4o');
  });

  it('updates draft on prop change', () => {
    const { rerender } = render(
      <ModelTextInput model="gpt-4o" defaultModel="gpt-4o" onModelChange={vi.fn()} />
    );

    rerender(<ModelTextInput model="gpt-4o-mini" defaultModel="gpt-4o" onModelChange={vi.fn()} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    expect(input.value).toBe('gpt-4o-mini');
  });

  it('commits on blur', () => {
    const onModelChange = vi.fn();
    render(<ModelTextInput model="gpt-4o" defaultModel="gpt-4o" onModelChange={onModelChange} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-4o-mini' } });
    fireEvent.blur(input);

    expect(onModelChange).toHaveBeenCalledWith('gpt-4o-mini');
  });

  it('commits on Enter key', () => {
    const onModelChange = vi.fn();
    render(<ModelTextInput model="gpt-4o" defaultModel="gpt-4o" onModelChange={onModelChange} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-4o-mini' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onModelChange).toHaveBeenCalledWith('gpt-4o-mini');
  });

  it('does not commit empty/whitespace', () => {
    const onModelChange = vi.fn();
    render(<ModelTextInput model="gpt-4o" defaultModel="gpt-4o" onModelChange={onModelChange} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('does not commit when unchanged', () => {
    const onModelChange = vi.fn();
    render(<ModelTextInput model="gpt-4o" defaultModel="gpt-4o" onModelChange={onModelChange} />);

    const input = screen.getByTestId('model-input') as HTMLInputElement;
    fireEvent.blur(input);

    expect(onModelChange).not.toHaveBeenCalled();
  });
});
