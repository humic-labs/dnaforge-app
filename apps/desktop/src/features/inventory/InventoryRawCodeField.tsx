import { TextArea } from '../../components/ui';
import { PhysicalField } from './InventoryPhysicalControls';
import { inventoryRawTextOffset } from './inventory-code-input';

export function InventoryRawCodeField({
  label,
  value,
  onChange,
  onEnter,
  autoFocus,
  required,
  disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  onEnter?(): void;
  autoFocus?: boolean;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <PhysicalField label={label}>
      <TextArea
        aria-label={label}
        rows={2}
        value={value}
        autoFocus={autoFocus}
        required={required}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          event.preventDefault();
          const start = inventoryRawTextOffset(value, event.currentTarget.selectionStart);
          const end = inventoryRawTextOffset(value, event.currentTarget.selectionEnd);
          onChange(
            value.slice(0, start) + event.clipboardData.getData('text/plain') + value.slice(end)
          );
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onEnter?.();
        }}
      />
    </PhysicalField>
  );
}
