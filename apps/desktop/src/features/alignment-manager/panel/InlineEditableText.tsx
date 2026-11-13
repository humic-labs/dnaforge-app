import { useState, useRef, useEffect } from 'react';
import { safeFocus } from '../../../shared/utils/safeFocus';

export function InlineEditableText({
  value,
  onSave,
  className,
}: {
  value: string;
  onSave: (newValue: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && safeFocus(inputRef.current)) {
      inputRef.current!.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => {
          const trimmed = editValue.trim();
          if (trimmed && trimmed !== value) onSave(trimmed);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const trimmed = editValue.trim();
            if (trimmed && trimmed !== value) onSave(trimmed);
            setEditing(false);
          } else if (e.key === 'Escape') {
            setEditValue(value);
            setEditing(false);
          }
        }}
        className="bg-bg border border-accent rounded px-1 text-sm font-medium outline-none w-full"
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={`cursor-text ${className ?? ''}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditValue(value);
        setEditing(true);
      }}
      title="Double-click to rename"
    >
      {value}
    </span>
  );
}
