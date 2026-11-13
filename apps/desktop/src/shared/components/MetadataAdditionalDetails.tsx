import { MetadataRow, MetadataList } from './MetadataSection';
import { MetadataValue } from './MetadataValue';

export function MetadataAdditionalDetails({
  entries,
}: {
  entries: readonly { key: string; label: string; value: unknown }[];
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-label="Additional details" className="space-y-2">
      <h3 className="text-xs font-semibold text-fg-muted">Additional details</h3>
      <MetadataList>
        {entries.map((entry) => (
          <MetadataRow key={entry.key} label={entry.label}>
            <MetadataValue type="text" value={entry.value} />
          </MetadataRow>
        ))}
      </MetadataList>
    </section>
  );
}
