import { MenuNativeSelect } from '@waypoint/ui-components';
export function MolecularVariationPicker({
  variations,
  activeId,
  disabled,
  onSelect,
  label = 'Saved color variations',
}: {
  variations: readonly { id: string; name: string }[];
  activeId?: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  label?: string;
}) {
  return (
    <span className="inline-block min-w-0 flex-1">
      <MenuNativeSelect
        density="compact"
        aria-label={label}
        title={variations.find((item) => item.id === activeId)?.name}
        value={activeId ?? ''}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="" disabled>
          Choose a saved variation
        </option>
        {variations.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </MenuNativeSelect>
    </span>
  );
}
