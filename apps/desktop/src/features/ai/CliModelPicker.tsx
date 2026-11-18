import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentCliModelCapabilityShape, AgentTransport } from '../../platform';
import { type CodexAuthMode } from '../../shared/codex-model-support';
import { PortalMenu } from '../../components/PortalMenu';
import { MenuRow, MenuSearchInput, MenuTrigger, useMenu } from '@waypoint/ui-components';
import { safeFocus } from '../../shared/utils/safeFocus';
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

export interface CliModelPickerProps {
  transport: AgentTransport;
  model: string | null;
  onRefreshModels?: () => void | Promise<void>;
  onModelChange: (transport: AgentTransport, model: string | null) => void | Promise<void>;
  selectTestId: string;
  customInputTestId: string;
  defaultModel?: string | null;
  codexAuthMode?: CodexAuthMode;
  availableModels?: readonly AgentCliModelCapabilityShape[];
  customInputPlacement?: 'inline' | 'replace-select';
  disabled?: boolean;
  ariaLabel?: string;
  appearance?: 'settings' | 'inline';
}

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
  defaultModel = null,
  codexAuthMode,
  availableModels = [],
  customInputPlacement = 'inline',
  disabled = false,
  ariaLabel,
  appearance = 'inline',
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const density = appearance === 'settings' ? 'form' : 'compact';
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

  const menu = useMenu({
    items: pickerOptions.map((option) => ({ id: option.value, textValue: option.label, disabled })),
    selectedId: selectValue,
    onActivate: selectModelValue,
    onFocusItem: (id) =>
      safeFocus(
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-item-id="${CSS.escape(id)}"]`)
      ),
  });

  const customInput = customInputOpen ? (
    <div className={`flex min-w-0 items-center gap-1 ${appearance === 'inline' ? 'w-44' : ''}`}>
      <div className="min-w-0 flex-1">
        <MenuSearchInput
          type="text"
          density={density}
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
        />
      </div>
      {replaceSelectWithCustomInput ? (
        <MenuTrigger
          density={density}
          variant="toolbar"
          iconOnly
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setCustomInputOpen(false)}
          title="Show model choices"
          aria-label={`Show ${transportLabel} model choices`}
          data-testid={`${customInputTestId}-picker-button`}
        />
      ) : null}
    </div>
  ) : null;

  return (
    <div className={appearance === 'settings' ? 'min-w-0' : 'flex min-w-0 items-center gap-1'}>
      {!replaceSelectWithCustomInput ? (
        <div className={`min-w-0 ${appearance === 'inline' ? 'max-w-[14rem]' : ''}`}>
          <MenuTrigger
            ref={buttonRef}
            density={density}
            variant={appearance === 'settings' ? 'field' : 'toolbar'}
            role="combobox"
            disabled={disabled}
            open={menu.isOpen}
            onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu())}
            onKeyDown={menu.handleKeyDown}
            aria-label={ariaLabel ?? `${transportLabel} model`}
            aria-haspopup="listbox"
            aria-controls={menu.isOpen ? `${selectTestId}-menu` : undefined}
            title={
              currentOverrideModel
                ? `${transportLabel} model: ${getCliModelDisplayLabel(transport, currentOverrideModel, codexAuthMode, availableModels)}`
                : configuredDefaultModel
                  ? `${transportLabel} default: ${defaultModelLabel}`
                  : `${transportLabel} uses its provider-selected default model`
            }
            data-testid={selectTestId}
            data-value={selectValue}
            data-settings-control={appearance === 'settings' ? 'select' : undefined}
          >
            {selectedLabel}
          </MenuTrigger>
          <PortalMenu
            menu={menu}
            open={menu.isOpen}
            anchorRef={buttonRef}
            surfaceRef={menuRef}
            role="listbox"
            aria-label={`${transportLabel} models`}
            id={`${selectTestId}-menu`}
            data-testid={`${selectTestId}-menu`}
            density={density}
            selection
            onRequestClose={menu.close}
          >
            {pickerOptions.map((option) => (
              <MenuRow
                key={option.value}
                role="option"
                aria-selected={option.value === selectValue}
                selected={option.value === selectValue}
                active={option.value === menu.activeId}
                disabled={disabled}
                title={option.title}
                tabIndex={option.value === menu.activeId ? 0 : -1}
                onFocus={() => menu.point(option.value)}
                onMouseMove={() => menu.point(option.value)}
                onClick={() => menu.activate(option.value)}
                data-testid={`${selectTestId}-option-${option.value}`}
                data-value={option.value}
                data-menu-item-id={option.value}
              >
                {option.label}
              </MenuRow>
            ))}
          </PortalMenu>
        </div>
      ) : null}
      {customInput}
      {unavailableSelection && (
        <span className="text-xs text-danger" data-testid={`${selectTestId}-model-error`}>
          Choose an available model or the provider default.
        </span>
      )}
    </div>
  );
}
