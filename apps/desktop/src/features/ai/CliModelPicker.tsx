import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentCliModelCapabilityShape, AgentTransport } from '../../platform';
import { type CodexAuthMode } from '../../shared/codex-model-support';
import { ChatComposerDisclosureIcon } from '../../components/ChatComposerDisclosureIcon';
import { ChatComposerPickerLabel } from '../../components/ChatComposerPickerLabel';
import { PortalMenu } from '../../components/PortalMenu';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_SELECT_CARET_CLASS,
  SettingsSelect,
} from '../../components/SettingsSubsection';
import { AGENT_TRANSPORT_LABELS } from './agent-cli-labels';
import {
  CLI_CUSTOM_MODEL_SELECT_VALUE,
  CLI_DEFAULT_MODEL_SELECT_VALUE,
  getCliDefaultModelDisplayLabel,
  getCliModelCatalogOptions,
  getCliModelDisplayLabel,
  getCliModelSelectValue,
  isCliModelInCatalog,
} from './cli-model-catalog';

interface CliModelPickerBaseProps {
  transport: AgentTransport;
  model: string | null;
  onRefreshModels?: () => void | Promise<void>;
  onModelChange: (transport: AgentTransport, model: string | null) => void | Promise<void>;
  selectTestId: string;
  customInputTestId: string;
  defaultModel?: string | null;
  codexAuthMode?: CodexAuthMode;
  availableModels?: readonly AgentCliModelCapabilityShape[];
  containerClassName?: string;
  customInputPlacement?: 'inline' | 'replace-select';
  disabled?: boolean;
  ariaLabel?: string;
}

export type CliModelPickerProps = CliModelPickerBaseProps &
  (
    | { appearance: 'settings'; selectClassName?: never; customInputClassName?: never }
    | { appearance?: 'default'; selectClassName: string; customInputClassName: string }
  );

interface CliModelPickerOption {
  value: string;
  label: string;
  selectedLabel?: string;
  title?: string;
}

function normalizeModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed || null;
}

export function CliModelPicker({
  transport,
  model,
  onModelChange,
  onRefreshModels,
  selectTestId,
  customInputTestId,
  selectClassName = '',
  customInputClassName = '',
  defaultModel = null,
  codexAuthMode,
  availableModels = [],
  containerClassName = 'flex min-w-0 items-center gap-1',
  customInputPlacement = 'inline',
  disabled = false,
  ariaLabel,
  appearance = 'default',
}: CliModelPickerProps) {
  const options = useMemo(
    () => getCliModelCatalogOptions(transport, codexAuthMode, availableModels),
    [availableModels, codexAuthMode, transport]
  );
  const requestedModel = normalizeModel(model);
  const currentModel = requestedModel;
  const configuredDefaultModel = normalizeModel(defaultModel);
  const currentOverrideModel =
    currentModel && currentModel !== configuredDefaultModel ? currentModel : null;
  const currentModelIsCustom =
    !!currentOverrideModel &&
    !isCliModelInCatalog(transport, currentOverrideModel, codexAuthMode, availableModels);
  const unavailableSelection =
    transport === 'codex-sdk' &&
    !!currentModel &&
    !options.some((option) => option.value === currentModel);
  const [customDraft, setCustomDraft] = useState(currentOverrideModel ?? '');
  const [customInputOpen, setCustomInputOpen] = useState(currentModelIsCustom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const transportLabel = AGENT_TRANSPORT_LABELS[transport];

  useEffect(() => {
    setCustomDraft(currentOverrideModel ?? '');
    setCustomInputOpen(currentModelIsCustom);
  }, [currentOverrideModel, currentModelIsCustom]);

  const commitModel = useCallback(
    (nextModel: string | null) => {
      const normalizedNextModel =
        nextModel && nextModel === configuredDefaultModel ? null : nextModel;
      if (currentOverrideModel === normalizedNextModel) return;
      void onModelChange(transport, normalizedNextModel);
    },
    [configuredDefaultModel, currentOverrideModel, onModelChange, transport]
  );

  const commitCustomDraft = useCallback(() => {
    const nextModel = normalizeModel(customDraft);
    commitModel(nextModel);
    if (!nextModel) {
      setCustomInputOpen(false);
    }
  }, [commitModel, customDraft]);

  const selectValue = useMemo(() => {
    if (customInputOpen) return CLI_CUSTOM_MODEL_SELECT_VALUE;
    return getCliModelSelectValue(transport, currentOverrideModel, codexAuthMode, availableModels);
  }, [availableModels, codexAuthMode, currentOverrideModel, customInputOpen, transport]);

  const customOptionLabel = currentModelIsCustom
    ? `Custom: ${getCliModelDisplayLabel(transport, currentOverrideModel, codexAuthMode, availableModels)}`
    : 'Custom model...';
  const defaultModelLabel = getCliDefaultModelDisplayLabel(
    transport,
    configuredDefaultModel,
    codexAuthMode,
    availableModels
  );
  const defaultOptionLabel = configuredDefaultModel
    ? /^default\b/iu.test(defaultModelLabel)
      ? defaultModelLabel
      : `${defaultModelLabel} (default)`
    : 'Provider default model';
  const replaceSelectWithCustomInput = customInputPlacement === 'replace-select' && customInputOpen;
  const pickerOptions = useMemo<CliModelPickerOption[]>(
    () => [
      {
        value: CLI_DEFAULT_MODEL_SELECT_VALUE,
        label: defaultOptionLabel,
        selectedLabel: defaultModelLabel,
        title: configuredDefaultModel
          ? `Use the ${transportLabel} configured default: ${defaultModelLabel}`
          : undefined,
      },
      ...options
        .filter((option) => option.value !== configuredDefaultModel)
        .map((option) => ({
          value: option.value,
          label: option.label,
          title: option.description,
        })),
      {
        value: CLI_CUSTOM_MODEL_SELECT_VALUE,
        label: customOptionLabel,
        title: 'Use a model name that is not in the detected provider catalog.',
      },
      ...(onRefreshModels
        ? [{ value: '__refresh_cli_models__', label: 'Refresh model choices' }]
        : []),
    ],
    [
      configuredDefaultModel,
      customOptionLabel,
      defaultModelLabel,
      defaultOptionLabel,
      options,
      onRefreshModels,
      transportLabel,
    ]
  );
  const selectedOption =
    pickerOptions.find((option) => option.value === selectValue) ?? pickerOptions[0];
  const selectedLabel = selectedOption.selectedLabel ?? selectedOption.label;
  const selectModelValue = useCallback(
    (nextValue: string) => {
      setPickerOpen(false);
      if (nextValue === '__refresh_cli_models__') {
        void onRefreshModels?.();
        return;
      }
      if (nextValue === CLI_DEFAULT_MODEL_SELECT_VALUE) {
        setCustomInputOpen(false);
        setCustomDraft('');
        commitModel(null);
        return;
      }
      if (nextValue === CLI_CUSTOM_MODEL_SELECT_VALUE) {
        setCustomDraft(currentOverrideModel ?? '');
        setCustomInputOpen(true);
        return;
      }
      setCustomInputOpen(false);
      setCustomDraft('');
      commitModel(nextValue);
    },
    [commitModel, currentOverrideModel, onRefreshModels]
  );

  const customInputElement = customInputOpen ? (
    <input
      type="text"
      value={customDraft}
      disabled={disabled}
      onChange={(event) => setCustomDraft(event.currentTarget.value)}
      onBlur={commitCustomDraft}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitCustomDraft();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setCustomDraft(currentOverrideModel ?? '');
          setCustomInputOpen(false);
        }
      }}
      placeholder="Model name"
      aria-label={`${transportLabel} custom model`}
      title={`Custom ${transportLabel} model`}
      data-testid={customInputTestId}
      className={`${appearance === 'settings' ? SETTINGS_FIELD_CLASS : customInputClassName} ${replaceSelectWithCustomInput ? (appearance === 'settings' ? 'pr-10' : 'pr-7') : ''}`}
    />
  ) : null;
  const customInput = replaceSelectWithCustomInput ? (
    <div className="relative min-w-0">
      {customInputElement}
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setCustomInputOpen(false)}
        className={`absolute right-0 top-0 inline-flex ${appearance === 'settings' ? `h-full w-10 ${SETTINGS_SELECT_CARET_CLASS}` : 'h-7 w-7 text-fg-subtle'} items-center justify-center rounded-r-md transition-colors hover:bg-bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50`}
        title="Show model choices"
        aria-label={`Show ${transportLabel} model choices`}
        data-testid={`${customInputTestId}-picker-button`}
      >
        <ChatComposerDisclosureIcon />
      </button>
    </div>
  ) : (
    customInputElement
  );

  return (
    <div className={containerClassName}>
      {!replaceSelectWithCustomInput &&
        (appearance === 'settings' ? (
          <SettingsSelect
            value={selectValue}
            onValueChange={selectModelValue}
            ariaLabel={ariaLabel ?? `${transportLabel} model`}
            disabled={disabled}
            testId={selectTestId}
            options={pickerOptions.map((option) => ({
              ...option,
              testId: `${selectTestId}-option-${option.value}`,
            }))}
            title={
              currentOverrideModel
                ? `${transportLabel} model: ${getCliModelDisplayLabel(transport, currentOverrideModel, codexAuthMode, availableModels)}`
                : configuredDefaultModel
                  ? `${transportLabel} default: ${defaultModelLabel}`
                  : `${transportLabel} uses its provider-selected default model`
            }
          />
        ) : (
          <>
            <button
              ref={buttonRef}
              type="button"
              disabled={disabled}
              onClick={() => setPickerOpen((value) => !value)}
              aria-label={ariaLabel ?? `${transportLabel} model`}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              title={
                currentOverrideModel
                  ? `${transportLabel} model: ${getCliModelDisplayLabel(transport, currentOverrideModel, codexAuthMode, availableModels)}`
                  : configuredDefaultModel
                    ? `${transportLabel} default: ${defaultModelLabel}`
                    : `${transportLabel} uses its provider-selected default model`
              }
              data-testid={selectTestId}
              data-value={selectValue}
              className={`${selectClassName} ${
                pickerOpen ? 'bg-border/40 text-fg dark:bg-border-hover/60' : ''
              }`}
            >
              <ChatComposerPickerLabel label={selectedLabel} />
              <ChatComposerDisclosureIcon open={pickerOpen} />
            </button>
            <PortalMenu
              open={pickerOpen}
              anchorRef={buttonRef}
              role="listbox"
              data-testid={`${selectTestId}-menu`}
              className="py-1"
              onRequestClose={() => setPickerOpen(false)}
            >
              {pickerOptions.map((option) => {
                const active = option.value === selectValue;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    title={option.title}
                    onClick={() => selectModelValue(option.value)}
                    data-testid={`${selectTestId}-option-${option.value}`}
                    data-value={option.value}
                    className={`flex w-full min-w-0 items-center gap-2 whitespace-nowrap px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                      active
                        ? 'bg-border/45 text-accent dark:bg-border-hover/65'
                        : 'text-fg-muted hover:bg-border/45 hover:text-fg dark:hover:bg-border-hover/65'
                    }`}
                  >
                    <span className="min-w-0 truncate">{option.label}</span>
                    {active && (
                      <span className="ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
                    )}
                  </button>
                );
              })}
            </PortalMenu>
          </>
        ))}
      {customInput}
      {unavailableSelection && (
        <span className="text-xs text-danger" data-testid={`${selectTestId}-model-error`}>
          Choose an available model or the provider default.
        </span>
      )}
    </div>
  );
}
