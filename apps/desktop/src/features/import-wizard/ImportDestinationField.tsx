import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { FolderIcon } from '../../components/icons';
import { ChatComposerDisclosureIcon } from '../../components/ChatComposerDisclosureIcon';
import {
  SETTINGS_SELECT_CARET_CLASS,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from '../../components/SettingsSubsection';

export const ImportDestinationField = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'className'> & {
    label: string;
    open: boolean;
  }
>(function ImportDestinationField({ label, open, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      className={SETTINGS_SELECT_TRIGGER_CLASS}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FolderIcon className="h-4 w-4 shrink-0 text-fg-subtle" />
        <span className="truncate">{label}</span>
      </span>
      <ChatComposerDisclosureIcon open={open} className={SETTINGS_SELECT_CARET_CLASS} />
    </button>
  );
});
