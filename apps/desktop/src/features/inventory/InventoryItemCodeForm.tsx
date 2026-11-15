import { useEffect, useState, type FormEvent } from 'react';
import { Button, Notice, TextArea } from '../../components/ui';
import type {
  InventoryController,
  InventoryControllerState,
  InventoryData,
  InventoryItemCodeLookupState,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField } from './InventoryPhysicalControls';
import { InventoryRawCodeField } from './InventoryRawCodeField';
import { InventoryItemCodeResult } from './InventoryItemCodeResult';
import { inventoryCodeInput } from './inventory-code-input';
import type { InventoryItemCodeDialog } from './inventory-item-code-view';
import type { InventoryItem } from './inventory-view';

export function InventoryItemCodeForm({
  dialog,
  data,
  controller,
  status,
  lookup,
  materialNames,
  onClose,
  onInspect,
}: {
  dialog: InventoryItemCodeDialog;
  data: InventoryData;
  controller: InventoryController;
  status: InventoryControllerState;
  lookup: InventoryItemCodeLookupState;
  materialNames: Readonly<Record<string, string>>;
  onClose(): void;
  onInspect(item: InventoryItem): void;
}) {
  const [namespace, setNamespace] = useState('');
  const [raw, setRaw] = useState('');
  const [allNamespaces, setAllNamespaces] = useState(dialog.kind === 'item-code-lookup');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const framed = inventoryCodeInput(raw);
  const code = dialog.kind === 'item-code-retire' ? data.state.itemCodes[dialog.codeId] : undefined;
  const expected =
    dialog.kind === 'item-code-attach'
      ? dialog.item
      : dialog.kind === 'item-code-lookup'
        ? dialog.expected
        : undefined;
  const title =
    dialog.kind === 'item-code-retire'
      ? 'Retire code'
      : dialog.kind === 'item-code-attach'
        ? 'Attach existing code'
        : expected
          ? 'Check code'
          : 'Scan or enter code';
  useEffect(() => {
    controller.clearItemCodeLookup();
    return () => controller.clearItemCodeLookup();
  }, [controller]);
  function changed(update: () => void) {
    controller.clearItemCodeLookup();
    setError(null);
    update();
  }
  function check() {
    setError(null);
    void controller.resolveItemCode({
      namespace: allNamespaces && dialog.kind === 'item-code-lookup' ? null : namespace,
      value: framed.value,
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (dialog.kind === 'item-code-lookup') return;
      const command =
        dialog.kind === 'item-code-retire'
          ? { kind: 'retire-item-code' as const, codeId: dialog.codeId, reason: reason.trim() }
          : {
              kind: 'attach-item-code' as const,
              id: crypto.randomUUID(),
              namespace,
              value: framed.value,
              item: dialog.item,
              reason: reason.trim(),
            };
      if (await controller.submit([command], title)) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the item code.');
    }
  }
  return (
    <InventoryPhysicalDialog
      title={title}
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={dialog.kind === 'item-code-lookup' ? undefined : (event) => void submit(event)}
      submitLabel={dialog.kind === 'item-code-attach' ? 'Attach code' : 'Retire code'}
      disabled={dialog.kind === 'item-code-retire' && code?.lifecycle.kind !== 'active'}
    >
      <div data-testid="inventory-item-code-form" className="space-y-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p className="break-all text-xs text-fg-muted">
          Project {data.project.projectId} · Inventory {data.project.defaultInventoryId}
        </p>
        {expected ? (
          <p className="break-all text-sm" data-testid="inventory-code-expected-item">
            Selected item: {expected.kind}:{expected.id}
          </p>
        ) : null}
        {dialog.kind === 'item-code-retire' ? (
          <>
            <p>
              Namespace: <code>{JSON.stringify(code?.namespace)}</code>
            </p>
            <p>
              Exact code:{' '}
              <code className="whitespace-pre-wrap break-all">{JSON.stringify(code?.value)}</code>
            </p>
            <Notice>
              The exact namespace and code remain reserved for this item after retirement.
            </Notice>
          </>
        ) : (
          <>
            {dialog.kind === 'item-code-lookup' ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allNamespaces}
                  onChange={(event) => changed(() => setAllNamespaces(event.target.checked))}
                />
                Search all namespaces
              </label>
            ) : null}
            <InventoryRawCodeField
              label="Namespace"
              value={namespace}
              onChange={(value) => changed(() => setNamespace(value))}
              onEnter={check}
              required={dialog.kind === 'item-code-attach'}
              disabled={dialog.kind === 'item-code-lookup' && allNamespaces}
            />
            <InventoryRawCodeField
              label="Code"
              value={raw}
              onChange={(value) => changed(() => setRaw(value))}
              onEnter={check}
              autoFocus
              required={dialog.kind === 'item-code-attach'}
            />
            <div className="space-y-1 break-all text-xs">
              <p>
                Namespace:{' '}
                <code>
                  {allNamespaces && dialog.kind === 'item-code-lookup'
                    ? 'All namespaces'
                    : JSON.stringify(namespace)}
                </code>
              </p>
              <p>
                Raw input:{' '}
                <code data-testid="inventory-code-raw" className="whitespace-pre-wrap">
                  {JSON.stringify(raw)}
                </code>
              </p>
              <p>
                Exact code:{' '}
                <code data-testid="inventory-code-value" className="whitespace-pre-wrap">
                  {JSON.stringify(framed.value)}
                </code>
              </p>
              <p className="text-fg-muted">
                {framed.terminator
                  ? `Removed one trailing ${framed.terminator} scanner terminator.`
                  : 'No scanner terminator removed.'}{' '}
                One trailing CRLF, LF or CR is supported. All other characters remain unchanged.
              </p>
            </div>
            <Button onClick={check} disabled={lookup.kind === 'resolving'}>
              {dialog.kind === 'item-code-attach' || expected ? 'Check code' : 'Look up'}
            </Button>
            {lookup.kind === 'resolving' ? <p role="status">Looking up exact code…</p> : null}
            {lookup.kind === 'unavailable' ? (
              <Notice tone="error">
                <div data-testid="inventory-code-unavailable" className="space-y-2">
                  <p>Lookup unavailable</p>
                  <p>{lookup.message}</p>
                  <Button onClick={() => void controller.refresh()}>Refresh inventory</Button>
                </div>
              </Notice>
            ) : null}
            {lookup.kind === 'ready' ? (
              <InventoryItemCodeResult
                lookup={lookup.lookup}
                materialNames={materialNames}
                expected={
                  expected
                    ? {
                        projectId: data.project.projectId,
                        inventoryId: data.project.defaultInventoryId,
                        item: expected,
                      }
                    : undefined
                }
                onInspect={onInspect}
              />
            ) : null}
          </>
        )}
        {dialog.kind !== 'item-code-lookup' ? (
          <PhysicalField label="Reason">
            <TextArea
              aria-label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </PhysicalField>
        ) : null}
      </div>
    </InventoryPhysicalDialog>
  );
}
