import { Button } from '../../components/ui';
import type { InventoryData } from './inventory-controller';
import type { InventoryItemCodeDialog } from './inventory-item-code-view';
import type { InventoryItem } from './inventory-view';

export function InventoryItemCodes({
  data,
  item,
  editable,
  onDialog,
}: {
  data: InventoryData;
  item: InventoryItem;
  editable: boolean;
  onDialog(dialog: InventoryItemCodeDialog): void;
}) {
  const record =
    item.kind === 'storage' ? data.state.storage[item.id] : data.state.vessels[item.id];
  if (!record) return null;
  const fixedWell = item.kind === 'vessel' && data.state.vessels[item.id].kind === 'fixed-well';
  const codes = Object.values(data.state.itemCodes).filter(
    (code) => code.item.kind === item.kind && code.item.id === item.id
  );
  return (
    <section
      data-testid="inventory-item-codes"
      data-item-id={item.id}
      data-item-kind={item.kind}
      className="space-y-3 rounded border border-border p-3 text-xs"
    >
      <h3 className="text-sm font-semibold">Codes and labels</h3>
      <p className="break-all">
        {item.kind}:{item.id}
      </p>
      {fixedWell ? (
        <p>Permanent wells use the plate code and a well coordinate.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!editable || record.lifecycle !== 'active'}
            onClick={() => onDialog({ kind: 'item-code-attach', item })}
          >
            Attach existing code
          </Button>
          <Button onClick={() => onDialog({ kind: 'item-code-lookup', expected: item })}>
            Check code
          </Button>
        </div>
      )}
      {codes.length ? (
        codes.map((code) => (
          <article
            key={code.id}
            data-code-id={code.id}
            data-code-state={code.lifecycle.kind}
            className="space-y-1 border-t border-border pt-3"
          >
            <p>
              Namespace: <code>{JSON.stringify(code.namespace)}</code>
            </p>
            <p>
              Exact code:{' '}
              <code className="whitespace-pre-wrap break-all">{JSON.stringify(code.value)}</code>
            </p>
            <p className="font-medium">{code.lifecycle.kind === 'active' ? 'Active' : 'Retired'}</p>
            <p>Attachment reason: {code.reason}</p>
            <p className="text-fg-muted">Attached {new Date(code.assignedAt).toLocaleString()}</p>
            {code.lifecycle.kind === 'retired' ? (
              <p>Retirement reason: {code.lifecycle.reason}</p>
            ) : (
              <Button
                disabled={!editable}
                onClick={() => onDialog({ kind: 'item-code-retire', codeId: code.id })}
              >
                Retire code
              </Button>
            )}
          </article>
        ))
      ) : (
        <p className="text-fg-muted">No codes are attached to this item.</p>
      )}
    </section>
  );
}
