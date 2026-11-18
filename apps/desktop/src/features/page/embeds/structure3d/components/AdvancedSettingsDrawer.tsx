'use client';

import { MenuNativeSelect } from '@waypoint/ui-components';

import { usePresentationListener } from '../../../../../presentation/PresentationSurface';

import { toUserMessage } from '@waypoint/user-messages';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { safeFocus } from '@/shared/utils/safeFocus';
import { STRUCTURE_VIEWER_BUTTON_CLASS } from './structureViewerStyles';
import type { AdvancedViewerSettings } from '../types';
import { DEFAULT_ADVANCED_SETTINGS } from '../types';
import {
  DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
  useMolecularPresentationPreferences,
} from '../molstar/molecularPresentationPreferences';

interface AdvancedSettingsDrawerProps {
  returnFocusTarget?: HTMLElement | null;
  primaryControls?: ReactNode;
  onUseCurrentFraming?: () => void;
  framingDisabled?: boolean;
  isOpen: boolean;
  onClose: () => void;
  settings: Partial<AdvancedViewerSettings>;
  onSettingsChange: (settings: Partial<AdvancedViewerSettings>) => void;
}

export const AdvancedSettingsDrawer = memo(function AdvancedSettingsDrawer({
  returnFocusTarget,
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  primaryControls,
  onUseCurrentFraming,
  framingDisabled,
}: AdvancedSettingsDrawerProps) {
  const presentationEvents = usePresentationListener();

  const drawerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ left: 8, top: 8, width: 300, maxHeight: 300 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const returnFocus = useMemo(
    () =>
      isOpen
        ? (returnFocusTarget ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null))
        : null,
    [isOpen, returnFocusTarget]
  );
  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const host = backdropRef.current?.getBoundingClientRect();
      if (!host) return;
      const gap = 8;
      const anchor = returnFocusTarget?.isConnected
        ? returnFocusTarget.getBoundingClientRect()
        : null;
      const width = Math.min(300, Math.max(0, host.width - 2 * gap));
      const right = anchor ? anchor.right : host.right - gap;
      const top = Math.max(gap, anchor ? anchor.bottom + gap : host.top + gap);
      setPlacement({
        left: Math.max(host.left + gap, right - width),
        top,
        width,
        maxHeight: Math.max(0, Math.min(host.bottom, window.innerHeight) - gap - top),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [isOpen, returnFocusTarget]);
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() =>
      safeFocus(drawerRef.current?.querySelector<HTMLElement>('button'))
    );
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[aria-modal="true"]') &&
        !drawerRef.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      closeRef.current();
    };
    presentationEvents.add(document, 'keydown', dismiss);
    return () => {
      cancelAnimationFrame(frame);
      presentationEvents.remove(document, 'keydown', dismiss);
      queueMicrotask(() => safeFocus(returnFocus, { preventScroll: true }));
    };
  }, [isOpen, returnFocus, presentationEvents]);

  const [framingError, setFramingError] = useState<string | null>(null);
  useEffect(() => setFramingError(null), [isOpen]);
  const preferences = useMolecularPresentationPreferences((state) => state.preferences);
  const updatePreferences = useMolecularPresentationPreferences((state) => state.update);
  const current: AdvancedViewerSettings = { ...DEFAULT_ADVANCED_SETTINGS, ...settings };

  const updateSetting = useCallback(
    <K extends keyof AdvancedViewerSettings>(key: K, value: AdvancedViewerSettings[K]) => {
      onSettingsChange({ ...settings, [key]: value });
    },
    [settings, onSettingsChange]
  );

  const handleReset = useCallback(() => {
    onSettingsChange({});
    updatePreferences(DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES);
  }, [onSettingsChange, updatePreferences]);

  if (!isOpen) return null;

  return (
    <>
      <div ref={backdropRef} className="pointer-events-none absolute inset-0" />

      {createPortal(
        <div
          ref={drawerRef}
          className="fixed bg-bg text-fg border border-border rounded-lg shadow-lg z-[10040] flex flex-col overflow-hidden"
          role="dialog"
          aria-label="Advanced structure settings"
          style={{ ...placement, fontSize: '12px' }}
        >
          <div className="flex shrink-0 items-center justify-between px-4 py-2 border-b border-border bg-bg-subtle">
            <span className="font-medium" style={{ fontSize: '13px' }}>
              Advanced Settings
            </span>
            <button
              type="button"
              aria-label="Close advanced settings"
              onClick={onClose}
              className="p-1 wp-interactive rounded text-fg-muted "
            >
              <CloseIcon />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-5">
            {primaryControls && (
              <SettingsSection title="Appearance">{primaryControls}</SettingsSection>
            )}
            <SettingsSection title="View">
              {onUseCurrentFraming && (
                <div className="space-y-1">
                  <button
                    type="button"
                    className={STRUCTURE_VIEWER_BUTTON_CLASS}
                    disabled={framingDisabled}
                    data-testid="molecular-use-current-framing"
                    onClick={() => {
                      try {
                        onUseCurrentFraming();
                        setFramingError(null);
                      } catch (error) {
                        setFramingError(
                          toUserMessage(error, 'failure.could-not-update-the-framing')
                        );
                      }
                    }}
                  >
                    Use current framing
                  </button>
                  {framingError && (
                    <p role="alert" className="text-error">
                      {toUserMessage(framingError, 'structure.failed')}
                    </p>
                  )}
                </div>
              )}
              <SliderRow
                label="Camera transition (ms)"
                value={preferences.cameraTransitionMs ?? 500}
                min={0}
                max={2000}
                step={100}
                onChange={(value) => updatePreferences({ cameraTransitionMs: value })}
              />
            </SettingsSection>
            <details className="group space-y-4">
              <summary className="cursor-pointer select-none font-medium text-fg-muted wp-interactive">
                More settings
              </summary>
              <SettingsSection title="New scenes">
                <SelectRow
                  label="Aligned comparison"
                  value={preferences.comparisonPresentation ?? 'overlay'}
                  options={[
                    { value: 'overlay', label: 'Include both structures' },
                    { value: 'authored', label: 'Agent chosen views' },
                  ]}
                  onChange={(value) =>
                    updatePreferences({ comparisonPresentation: value as 'overlay' | 'authored' })
                  }
                />
                <SelectRow
                  label="Nucleic acid backbone"
                  value={preferences.nucleotideBackbone ?? 'ribbon'}
                  options={[
                    { value: 'ribbon', label: 'Thick ribbon (default)' },
                    { value: 'authored', label: 'Authored shape (explicit)' },
                  ]}
                  onChange={(value) =>
                    updatePreferences({ nucleotideBackbone: value as 'ribbon' | 'authored' })
                  }
                />
                <SelectRow
                  label="Nucleotide detail"
                  value={preferences.nucleotideDetail}
                  options={[
                    { value: 'simplified', label: 'Bases + connectors' },
                    { value: 'atomic', label: 'Full atomic detail' },
                  ]}
                  onChange={(value) =>
                    updatePreferences({ nucleotideDetail: value as 'simplified' | 'atomic' })
                  }
                />
                <SliderRow
                  label="Cartoon thickness"
                  value={preferences.cartoonScale}
                  min={0.2}
                  max={3}
                  step={0.1}
                  onChange={(value) => updatePreferences({ cartoonScale: value })}
                />
                <ToggleRow
                  label="Retain polymer context"
                  checked={preferences.preservePolymerContext}
                  onChange={(value) => updatePreferences({ preservePolymerContext: value })}
                />
                <ToggleRow
                  label="Atomic binding-site detail"
                  checked={preferences.bindingSiteDetail === 'atomic'}
                  onChange={(value) =>
                    updatePreferences({ bindingSiteDetail: value ? 'atomic' : 'authored' })
                  }
                />
                <ToggleRow
                  label="Translucent interface surfaces"
                  checked={preferences.interfaceSurface === 'translucent'}
                  onChange={(value) =>
                    updatePreferences({ interfaceSurface: value ? 'translucent' : 'authored' })
                  }
                />
              </SettingsSection>
              <SettingsSection title="Ambient Occlusion">
                <ToggleRow
                  label="Enable AO"
                  checked={current.aoEnabled}
                  onChange={(v) => updateSetting('aoEnabled', v)}
                />
                {current.aoEnabled && (
                  <>
                    <SliderRow
                      label="Radius"
                      value={current.aoRadius}
                      min={1}
                      max={20}
                      step={1}
                      onChange={(v) => updateSetting('aoRadius', v)}
                    />
                    <SliderRow
                      label="Bias"
                      value={current.aoBias}
                      min={0}
                      max={2}
                      step={0.1}
                      onChange={(v) => updateSetting('aoBias', v)}
                    />
                    <SliderRow
                      label="Intensity"
                      value={current.aoIntensity}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(v) => updateSetting('aoIntensity', v)}
                    />
                  </>
                )}
              </SettingsSection>

              <SettingsSection title="Outlines">
                <ToggleRow
                  label="Enable Outlines"
                  checked={current.outlineEnabled}
                  onChange={(v) => updateSetting('outlineEnabled', v)}
                />
                {current.outlineEnabled && (
                  <>
                    <SliderRow
                      label="Scale"
                      value={current.outlineScale}
                      min={0.5}
                      max={3}
                      step={0.1}
                      onChange={(v) => updateSetting('outlineScale', v)}
                    />
                    <SliderRow
                      label="Threshold"
                      value={current.outlineThreshold}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(v) => updateSetting('outlineThreshold', v)}
                    />
                  </>
                )}
              </SettingsSection>

              <SettingsSection title="Lighting">
                <SliderRow
                  label="Ambient"
                  value={current.ambientIntensity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => updateSetting('ambientIntensity', v)}
                />
              </SettingsSection>

              <SettingsSection title="Quality">
                <SelectRow
                  label="Render Quality"
                  value={current.quality}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                    { value: 'highest', label: 'Highest' },
                  ]}
                  onChange={(v) => updateSetting('quality', v as AdvancedViewerSettings['quality'])}
                />
              </SettingsSection>
            </details>
          </div>

          <div className="px-4 py-2 border-t border-border">
            <button
              onClick={handleReset}
              className="w-full px-2 py-1.5 rounded border border-border wp-interactive text-fg-muted "
              style={{ fontSize: '11px' }}
            >
              Reset to Defaults
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
});

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h3
        className="font-medium text-fg-muted uppercase tracking-wide"
        style={{ fontSize: '10px', lineHeight: 1 }}
      >
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-fg" style={{ fontSize: '12px' }}>
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-4 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-bg-muted'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </button>
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-fg" style={{ fontSize: '12px' }}>
          {label}
        </span>
        <span className="text-fg-muted tabular-nums" style={{ fontSize: '12px' }}>
          {value.toFixed(step < 1 ? 2 : 0)}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 bg-bg-muted rounded-full appearance-none cursor-pointer accent-accent"
      />
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-fg" style={{ fontSize: '12px' }}>
        {label}
      </span>
      <span className="inline-block min-w-0">
        <MenuNativeSelect
          density="compact"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </MenuNativeSelect>
      </span>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
