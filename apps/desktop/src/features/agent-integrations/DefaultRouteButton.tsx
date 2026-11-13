import { CheckIcon } from '../../components/icons/glyphs';
import { SETTINGS_PRIMARY_BUTTON_CLASS } from '../../components/SettingsSubsection';

const CURRENT_DEFAULT_CLASS =
  'inline-flex cursor-default items-center gap-1 rounded-md bg-accent/10 px-3 py-2 text-xs font-medium text-accent';

export function DefaultRouteButton({
  isDefault,
  disabled = false,
  onClick,
  testId,
}: {
  isDefault: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  if (isDefault) {
    return (
      <button
        type="button"
        disabled
        aria-pressed="true"
        className={CURRENT_DEFAULT_CLASS}
        data-testid={testId}
        data-default="true"
      >
        <CheckIcon size={13} />
        Default
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed="false"
      className={SETTINGS_PRIMARY_BUTTON_CLASS}
      data-testid={testId}
      data-default="false"
    >
      Set as default
    </button>
  );
}
