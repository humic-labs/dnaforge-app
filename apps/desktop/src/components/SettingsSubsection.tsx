import { renderUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useId, type ReactNode, type Ref } from 'react';
import type { SettingsTargetId } from './settings-catalog';
import { Button as SettingsButton, Switch as SettingsSwitch } from './ui';
import {
  UI_PAGE_TITLE_CLASS as SETTINGS_PAGE_TITLE_CLASS,
  UI_SUBSECTION_TITLE_CLASS as SETTINGS_SUBSECTION_TITLE_CLASS,
  UI_SUBSECTION_DESCRIPTION_CLASS as SETTINGS_SUBSECTION_DESCRIPTION_CLASS,
} from './ui/styles';

export {
  TextField as SettingsInput,
  TextArea as SettingsTextarea,
  Button as SettingsButton,
  Notice as SettingsNotice,
  Select as SettingsSelect,
  Switch as SettingsSwitch,
  SegmentedControl as SettingsSegmentedControl,
} from './ui';
export type { SelectOption as SettingsSelectOption } from './ui';
export {
  UI_PAGE_TITLE_CLASS as SETTINGS_PAGE_TITLE_CLASS,
  UI_SUBSECTION_TITLE_CLASS as SETTINGS_SUBSECTION_TITLE_CLASS,
  UI_SUBSECTION_DESCRIPTION_CLASS as SETTINGS_SUBSECTION_DESCRIPTION_CLASS,
  UI_CONTENT_WIDTH_CLASS as SETTINGS_CONTENT_WIDTH_CLASS,
  UI_FORM_WIDTH_CLASS as SETTINGS_FORM_WIDTH_CLASS,
  UI_FORM_LONE_FIELD_SPAN_CLASS as SETTINGS_FORM_LONE_FIELD_SPAN_CLASS,
  UI_FORM_GRID_CLASS as SETTINGS_FORM_GRID_CLASS,
  UI_FIELD_CLASS as SETTINGS_FIELD_CLASS,
  UI_TEXTAREA_CLASS as SETTINGS_TEXTAREA_CLASS,
  UI_SURFACE_CLASS as SETTINGS_SURFACE_CLASS,
  UI_CARD_CLASS as SETTINGS_CARD_CLASS,
  UI_LIST_CLASS as SETTINGS_LIST_CLASS,
  UI_SPLIT_PANEL_CLASS as SETTINGS_SPLIT_PANEL_CLASS,
  UI_SPLIT_PANEL_LIST_CLASS as SETTINGS_SPLIT_PANEL_LIST_CLASS,
  UI_SPLIT_PANEL_EDITOR_CLASS as SETTINGS_SPLIT_PANEL_EDITOR_CLASS,
  UI_SECONDARY_BUTTON_CLASS as SETTINGS_SECONDARY_BUTTON_CLASS,
  UI_SEGMENTED_SURFACE_CLASS as SETTINGS_SEGMENTED_SURFACE_CLASS,
  segmentedOptionClass as settingsSegmentedOptionClass,
  UI_PRIMARY_BUTTON_CLASS as SETTINGS_PRIMARY_BUTTON_CLASS,
  UI_DANGER_BUTTON_CLASS as SETTINGS_DANGER_BUTTON_CLASS,
  UI_READONLY_FIELD_CLASS as SETTINGS_READONLY_FIELD_CLASS,
  splitPanelTabClass as settingsSplitPanelTabClass,
} from './ui/styles';

export function SettingsFormActions({
  dirty,
  busy,
  valid = true,
  onCancel,
  saveTestId,
}: {
  dirty: boolean;
  busy: boolean;
  valid?: boolean;
  onCancel: () => void;
  saveTestId?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <SettingsButton
        type="submit"
        variant="primary"
        disabled={busy || !dirty || !valid}
        data-testid={saveTestId}
      >
        {busy ? 'Saving…' : 'Save changes'}
      </SettingsButton>
      <SettingsButton disabled={busy || !dirty} onClick={onCancel}>
        Cancel
      </SettingsButton>
      <p role="status" className="text-xs text-fg-muted">
        {busy ? 'Saving changes…' : dirty ? 'Unsaved changes' : 'All changes saved'}
      </p>
    </div>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  testId,
  sectionRef,
  flushTop = false,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  testId?: string;
  sectionRef?: Ref<HTMLDivElement>;
  flushTop?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      ref={sectionRef}
      aria-labelledby={headingId}
      className={`min-w-0 py-7 ${flushTop ? '' : 'pt-9'}`}
      data-testid={testId}
    >
      <header className="mb-6">
        <h1 id={headingId} className={SETTINGS_PAGE_TITLE_CLASS}>
          {title}
        </h1>
        {description ? (
          <p className={SETTINGS_SUBSECTION_DESCRIPTION_CLASS}>{description}</p>
        ) : null}
      </header>
      <div className="min-w-0 space-y-5">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  targetId,
  htmlFor,
  description,
  children,
}: {
  targetId?: SettingsTargetId;
  label: ReactNode;
  htmlFor?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-settings-target={targetId}
      role={targetId ? 'group' : undefined}
      tabIndex={targetId ? -1 : undefined}
      aria-label={targetId ? String(label) : undefined}
      className="grid gap-2 py-2 sm:grid-cols-[minmax(150px,220px)_minmax(0,1fr)] sm:gap-5"
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
            {label}
          </label>
        ) : (
          <div className="text-sm font-medium text-fg">{label}</div>
        )}
        {description ? (
          <div className="mt-0.5 max-w-2xl text-xs leading-5 text-fg-muted">{description}</div>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SettingsToggle({
  label,
  targetId,
  description,
  checked,
  onChange,
  disabled,
  disabledReason,
}: {
  targetId?: SettingsTargetId;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  disabledReason?: UserMessage;
}) {
  return (
    <div
      data-settings-target={targetId}
      role={targetId ? 'group' : undefined}
      tabIndex={targetId ? -1 : undefined}
      aria-label={targetId ? String(label) : undefined}
      className="grid gap-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-5"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
          {label}
          {disabled && disabledReason ? (
            <span className="text-xs font-normal text-fg-muted">
              {renderUserMessage(disabledReason)}
            </span>
          ) : null}
        </div>
        {description ? (
          <div className="mt-0.5 max-w-2xl text-xs leading-5 text-fg-muted">{description}</div>
        ) : null}
      </div>
      <div className="flex justify-start sm:justify-end">
        <SettingsSwitch label={label} checked={checked} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

interface SettingsSubsectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  headingId?: string;
  trailing?: ReactNode;
  className?: string;
}

export function SettingsSubsectionHeader({
  title,
  description,
  headingId,
  trailing,
  className = '',
}: SettingsSubsectionHeaderProps) {
  return (
    <div className={`flex min-w-0 items-start justify-between gap-3 ${className}`.trim()}>
      <div className="min-w-0">
        <h2 id={headingId} className={SETTINGS_SUBSECTION_TITLE_CLASS}>
          {title}
        </h2>
        {description ? (
          <p className={SETTINGS_SUBSECTION_DESCRIPTION_CLASS}>{description}</p>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0 pt-1">{trailing}</div> : null}
    </div>
  );
}

interface SettingsSubsectionProps {
  targetId?: SettingsTargetId;
  title: string;
  description?: string;
  testId?: string;
  subsectionRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export function SettingsSubsection({
  targetId,
  title,
  description,
  testId,
  subsectionRef,
  children,
}: SettingsSubsectionProps) {
  return (
    <div
      data-settings-target={targetId}
      role={targetId ? 'group' : undefined}
      tabIndex={targetId ? -1 : undefined}
      aria-label={targetId ? title : undefined}
      ref={subsectionRef}
      data-testid={testId}
      className="pt-6 first:pt-0"
    >
      <SettingsSubsectionHeader title={title} description={description} className="mb-3" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
