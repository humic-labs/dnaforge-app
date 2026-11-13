import { geneticCodeLabel, type GeneticCodeSpec } from '@waypoint/sequence-utils';

export function MetadataValue({ type, value }: { type: string; value: unknown }) {
  if (value === undefined || value === null || value === '') return <span>-</span>;
  if (type === 'genetic_code' && (typeof value === 'number' || typeof value === 'object')) {
    return <>{geneticCodeLabel(value as GeneticCodeSpec)}</>;
  }
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>;
  if (typeof value === 'number')
    return <>{Number.isFinite(value) ? value.toLocaleString() : '-'}</>;
  if (typeof value === 'string') return <>{value}</>;
  if (Array.isArray(value))
    return value.length ? (
      <ul className="list-inside list-disc">
        {value.map((item, index) => (
          <li key={index}>
            <MetadataValue type="text" value={item} />
          </li>
        ))}
      </ul>
    ) : (
      <span>-</span>
    );
  if (typeof value === 'object') {
    if (
      type === 'quantity' &&
      'lexical' in value &&
      typeof value.lexical === 'string' &&
      'unit' in value &&
      typeof value.unit === 'string'
    )
      return (
        <>
          {value.lexical} {value.unit}
          {'compatibility' in value && value.compatibility !== 'compatible' ? (
            <span className="block text-warning">Unit not converted</span>
          ) : null}
        </>
      );
    if (type === 'record_relationship' && 'label' in value && typeof value.label === 'string')
      return (
        <>
          {value.label}
          {'resolution' in value && value.resolution === 'source_broken' ? (
            <span className="block text-warning">Not imported</span>
          ) : null}
        </>
      );
    if (
      type === 'attachment_reference' &&
      'logicalName' in value &&
      typeof value.logicalName === 'string'
    )
      return <>{value.logicalName}</>;
    if (type === 'formula_result' && 'sourceValue' in value)
      return (
        <>
          <MetadataValue
            type="text"
            value={
              'calculatedValue' in value &&
              'compatibility' in value &&
              value.compatibility === 'supported'
                ? value.calculatedValue
                : value.sourceValue
            }
          />
          <span className="block text-fg-subtle">
            {'stale' in value && value.stale ? 'Saved result · May be outdated' : 'Saved result'}
          </span>
          {'formula' in value && typeof value.formula === 'string' ? (
            <code className="block text-fg-subtle">{value.formula}</code>
          ) : null}
        </>
      );
    if (
      'mode' in value &&
      value.mode === 'inline' &&
      'bases' in value &&
      typeof value.bases === 'string'
    )
      return <span className="font-mono">{value.bases}</span>;
    if ('mode' in value && value.mode === 'unresolved')
      return <span className="text-warning">Sequence not available</span>;
  }
  return (
    <details>
      <summary>Stored value</summary>
      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
