import { SEQUENCE_DERIVED_PROPERTY_DEFINITIONS } from '../sequence-entity-schema';
import { MetadataRow, MetadataList } from './MetadataSection';

export function SequenceProperties({
  values,
  sizeTestId,
  sizeUnit,
}: {
  values: Readonly<Record<string, unknown>>;
  sizeTestId?: string;
  sizeUnit?: string;
}) {
  return (
    <section aria-label="Sequence properties">
      <h3 className="mb-2 text-xs font-semibold text-fg-muted">Sequence properties</h3>
      <MetadataList>
        {SEQUENCE_DERIVED_PROPERTY_DEFINITIONS.map((property) => {
          const value = values[property.key];
          return (
            <MetadataRow key={property.key} label={property.label}>
              <output
                className="tabular-nums"
                data-testid={sizeTestId}
                title="Calculated from the sequence"
              >
                {typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
                  ? `${value.toLocaleString()}${property.key === 'size' && sizeUnit ? ` ${sizeUnit}` : ''}`
                  : '-'}
              </output>
            </MetadataRow>
          );
        })}
      </MetadataList>
    </section>
  );
}
