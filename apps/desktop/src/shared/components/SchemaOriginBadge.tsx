import { UI_SURFACE_CLASS } from '../../components/ui/styles';

export function SchemaOriginBadge({ builtin }: { builtin: boolean }) {
  return (
    <span
      title={builtin ? 'Included with DNAForge' : 'Created for this Registry'}
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-normal text-fg-muted ${UI_SURFACE_CLASS}`}
    >
      {builtin ? 'Default' : 'Custom'}
    </span>
  );
}
