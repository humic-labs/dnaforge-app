import { ChevronRightIcon } from './icons';

interface ChatComposerDisclosureIconProps {
  open?: boolean;
  className?: string;
}

export function ChatComposerDisclosureIcon({
  open = false,
  className = '',
}: ChatComposerDisclosureIconProps) {
  return (
    <span
      aria-hidden="true"
      data-testid="chat-composer-picker-icon"
      className={`inline-flex h-2.5 w-2.5 flex-shrink-0 items-center justify-center opacity-100 transition-transform ${
        open ? '-rotate-90' : 'rotate-90'
      } ${className}`}
    >
      <ChevronRightIcon size={10} className="h-2.5 w-2.5 stroke-[2.5]" />
    </span>
  );
}
