interface ChatComposerPickerLabelProps {
  label: string;
  className?: string;
}

export function ChatComposerPickerLabel({ label, className = '' }: ChatComposerPickerLabelProps) {
  return <span className={`min-w-0 truncate ${className}`}>{label}</span>;
}
