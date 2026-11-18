import { MenuCaret } from '@waypoint/ui-components';

interface ChatComposerDisclosureIconProps {
  open?: boolean;
}

export function ChatComposerDisclosureIcon({ open = false }: ChatComposerDisclosureIconProps) {
  return (
    <span
      aria-hidden="true"
      data-testid="chat-composer-picker-icon"
      className="inline-flex shrink-0 items-center justify-center text-fg-muted"
    >
      <MenuCaret direction={open ? 'up' : 'down'} />
    </span>
  );
}
