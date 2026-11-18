import type { InventoryScientificProduction } from '@waypoint/domain-services';
import { inventoryAmountLabel, inventoryPrincipalLabel } from './inventory-view';
export function ScientificProductionFacts({
  production,
  proposed = false,
}: {
  production: InventoryScientificProduction;
  proposed?: boolean;
}) {
  return (
    <article
      className="space-y-3 rounded border border-border p-3"
      data-testid="scientific-production-facts"
      data-production-id={production.id}
    >
      <h4 className="font-semibold">
        {proposed ? 'Proposed completed production record' : 'Recorded completed manual production'}
      </h4>
      <p>
        DNA design: {production.design.document.name} · {production.design.document.length} bases ·{' '}
        {production.design.document.topology}
      </p>
      <p>Saved Run: {production.context.source.title}</p>
      <h5 className="font-medium">Inputs used</h5>
      {production.effects.sources.map((source) => (
        <p key={source.before.id} data-source-stock-id={source.before.id}>
          {source.vessel.name}: {inventoryAmountLabel(source.before.quantity)} →{' '}
          {inventoryAmountLabel(source.after.quantity)}
        </p>
      ))}
      <h5 className="font-medium">Measured product</h5>
      <p>
        {production.effects.lot.after.name} · {inventoryAmountLabel(production.output.quantity)} ·{' '}
        {production.effects.stock.vessel.name}
      </p>
      <p>Initial batch assessment: unassessed. Initial stock quality: quarantined.</p>
      <p>Method: {production.method}</p>
      <p>Reason: {production.reason}</p>
      <p>
        Recorded by {inventoryPrincipalLabel(production.by)} ·{' '}
        {new Date(production.at).toISOString()}
      </p>
      <p>
        This report preserves the completed manual preparation and its saved sources. Later changes
        leave these recorded facts unchanged.
      </p>
      <details>
        <summary>Recorded identities and exact original facts</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(production, null, 2)}
        </pre>
      </details>
    </article>
  );
}
