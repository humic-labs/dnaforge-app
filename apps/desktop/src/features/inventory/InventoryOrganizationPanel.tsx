import { useMemo, useState } from 'react';
import { inventoryAmountUnitDefinition, normalizeInventoryAmount } from '@waypoint/domain-services';
import { Button, Notice, Select, TextField, TextArea } from '../../components/ui';
import { useAuthStore } from '../../stores/auth-store';
import type { InventoryOrganizationSessionIdentity } from '../../shared/inventory-organization-client';
import { inventoryAmountLabel, vesselLocation } from './inventory-view';
import { useInventoryOrganization } from './useInventoryOrganization';

export function InventoryOrganizationPanel() {
  const auth = useAuthStore((store) => store.state);
  const session = auth.status === 'signed-in' ? auth.session : null;
  const identity = useMemo(() => {
    const expiry = session ? Date.parse(session.accessTokenExpiresAt) : NaN;
    return session && Number.isSafeInteger(expiry) && expiry > 0
      ? {
          accountId: session.accountId,
          desktopSessionId: session.desktopSessionId,
          knownAccessTokenExpiresAt: expiry,
        }
      : null;
  }, [session]);
  if (!identity || !session)
    return (
      <div className="p-5">
        <Notice tone="neutral">Sign in to choose an organization inventory.</Notice>
      </div>
    );
  return (
    <OrganizationInventoryWorkspace
      key={`${identity.accountId}:${identity.desktopSessionId}`}
      identity={identity}
      accountLabel={session.email ?? session.displayName ?? identity.accountId}
    />
  );
}

function OrganizationInventoryWorkspace({
  identity,
  accountLabel,
}: {
  identity: InventoryOrganizationSessionIdentity;
  accountLabel: string;
}) {
  const inventory = useInventoryOrganization(identity);
  const { view } = inventory;
  if (view.kind === 'hidden')
    return (
      <div className="p-5">
        <Notice tone="neutral">
          Your inventory access or session changed. Refresh your sign-in before continuing.
        </Notice>
      </div>
    );
  const confirmed = view.snapshot;
  const directory = view.directory?.directory;
  const selectedName = directory?.entries.find(
    (entry) => entry.header.target.inventoryId === inventory.target?.inventoryId
  )?.name;
  return (
    <section
      className="h-full overflow-auto p-5 text-fg"
      data-testid="organization-inventory"
      data-account-id={identity.accountId}
      data-attempt-state={
        inventory.attempt?.kind === 'read'
          ? inventory.attempt.value.kind
          : (inventory.attempt?.kind ?? 'unselected')
      }
    >
      <header className="mb-5 space-y-1">
        <h1 className="text-xl font-semibold">Organization inventory</h1>
        <p className="text-sm text-fg-muted">Account: {accountLabel}</p>
      </header>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="w-60 space-y-1">
          <label htmlFor="organization-inventory-organization" className="block text-sm">
            Organization
          </label>
          <Select
            id="organization-inventory-organization"
            ariaLabel="Inventory organization"
            value={inventory.orgId}
            options={[
              { value: '', label: 'Choose an organization' },
              ...inventory.organizations.map((organization) => ({
                value: organization.orgId,
                label: organization.displayName,
              })),
            ]}
            onValueChange={inventory.chooseOrganization}
          />
        </div>
        <div className="w-64 space-y-1">
          <label htmlFor="organization-inventory-target" className="block text-sm">
            Inventory
          </label>
          <Select
            id="organization-inventory-target"
            ariaLabel="Organization inventory"
            value={
              directory?.entries.some(
                (entry) => entry.header.target.inventoryId === inventory.target?.inventoryId
              )
                ? (inventory.target?.inventoryId ?? '')
                : ''
            }
            disabled={!directory || view.pending === 'directory'}
            options={[
              { value: '', label: 'Choose an inventory' },
              ...(directory?.entries ?? []).map((entry) => ({
                value: entry.header.target.inventoryId,
                label: entry.name,
              })),
            ]}
            onValueChange={inventory.chooseInventory}
          />
        </div>
        <Button onClick={inventory.refresh} disabled={Boolean(view.pending)}>
          {inventory.orgId ? 'Refresh inventory' : 'Refresh organizations'}
        </Button>
      </div>
      {inventory.organizationStatus && (
        <p role="status" className="mb-3 text-sm text-fg-muted">
          {inventory.organizationStatus}
        </p>
      )}
      {view.pending && (
        <p role="status" className="mb-3 text-sm">
          {view.pending === 'preview' ? 'Preparing preview…' : 'Loading inventory…'}
        </p>
      )}
      {view.failure && (
        <div className="mb-3">
          <Notice tone="warning">{view.failure.message}</Notice>
        </div>
      )}
      {directory && directory.entries.length === 0 && (
        <p className="text-sm text-fg-muted">
          No inventory is available to this account in this organization.
        </p>
      )}
      <OrganizationAttemptStatus inventory={inventory} />
      {confirmed && (
        <>
          <div
            className="mb-4 space-y-1"
            data-testid="organization-inventory-confirmation"
            data-inventory-id={confirmed.binding.target.inventoryId}
          >
            <h2 className="text-lg font-medium">{selectedName ?? 'Selected inventory'}</h2>
            <p className="text-sm">
              Confirmed history revision {confirmed.snapshot.header.revision}
            </p>
            <p className="text-sm">
              Permission:{' '}
              {
                { read: 'Read only', operate: 'Operate inventory', manage: 'Manage inventory' }[
                  confirmed.snapshot.header.permission
                ]
              }
            </p>
            <p className="text-xs text-fg-muted">
              Confirmed as of {new Date(confirmed.snapshot.header.asOf).toLocaleString()}
            </p>
            {confirmed.kind === 'cached-offline' && (
              <Notice tone="warning">
                Last confirmed inventory · Offline and read only. Refresh online before previewing
                use.
              </Notice>
            )}
          </div>
          <div className="mb-6 space-y-2" aria-label="Confirmed inventory stock">
            {Object.values(confirmed.snapshot.state.stocks).map((stock) => {
              const vessel = confirmed.snapshot.state.vessels[stock.vesselId];
              return (
                <article
                  key={stock.id}
                  data-stock-id={stock.id}
                  className="rounded border border-border p-3"
                >
                  <h3 className="font-medium">{vessel?.name ?? 'Vessel unavailable'}</h3>
                  <p>Confirmed quantity: {inventoryAmountLabel(stock.quantity)}</p>
                  <p className="text-sm text-fg-muted">
                    {vessel
                      ? vesselLocation(confirmed.snapshot.state, vessel)
                      : 'Location unavailable'}
                  </p>
                </article>
              );
            })}
            {Object.keys(confirmed.snapshot.state.stocks).length === 0 && (
              <p className="text-sm text-fg-muted">No recorded stock.</p>
            )}
          </div>
          <OrganizationUsePreview
            key={`${confirmed.binding.bindingEpoch}:${inventory.draftEpoch}`}
            inventory={inventory}
          />
        </>
      )}
    </section>
  );
}

function OrganizationUsePreview({
  inventory,
}: {
  inventory: ReturnType<typeof useInventoryOrganization>;
}) {
  const [stockId, setStockId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const { view } = inventory;
  if (view.kind !== 'visible' || !view.snapshot) return null;
  const state = view.snapshot.snapshot.state;
  const stocks = Object.values(state.stocks);
  const supportsVolume = (id: string) => {
    const quantity = state.stocks[id]?.quantity;
    return (
      quantity?.kind === 'known' &&
      inventoryAmountUnitDefinition(quantity.unit).dimension === 'volume'
    );
  };
  let validAmount = false;
  try {
    validAmount = normalizeInventoryAmount({ value: amount, unit: 'uL' }).value !== '0';
  } catch {}
  const edit = () => inventory.invalidate();
  const proposed =
    view.preview?.kind === 'ready' ? view.preview.preview.proposed.state.stocks[stockId] : null;
  return (
    <section
      aria-label="Preview inventory use"
      className="max-w-2xl space-y-3 rounded border border-border p-4"
    >
      <h2 className="font-medium">Preview use</h2>
      <p className="text-sm text-fg-muted">
        Preview a measured volume in µL. The proposed quantity is separate from confirmed inventory.
      </p>
      <div className="space-y-1">
        <label htmlFor="organization-use-stock" className="block text-sm">
          Stock
        </label>
        <Select
          id="organization-use-stock"
          ariaLabel="Stock to preview"
          value={stockId}
          disabled={!view.canPreview}
          options={[
            { value: '', label: 'Choose stock' },
            ...stocks.map((stock) => ({
              value: stock.id,
              label: `${state.vessels[stock.vesselId]?.name ?? 'Vessel unavailable'} · ${inventoryAmountLabel(stock.quantity)}`,
              disabled: !supportsVolume(stock.id),
              description: !supportsVolume(stock.id)
                ? 'A known volume is required for this preview'
                : undefined,
            })),
          ]}
          onValueChange={(value) => {
            setStockId(value);
            edit();
          }}
        />
      </div>
      <label className="block space-y-1 text-sm">
        <span>Amount to use (µL)</span>
        <TextField
          aria-label="Amount to use (µL)"
          inputMode="decimal"
          value={amount}
          disabled={!view.canPreview}
          onChange={(event) => {
            setAmount(event.target.value);
            edit();
          }}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>Reason for use</span>
        <TextArea
          aria-label="Reason for use"
          value={reason}
          maxLength={2000}
          disabled={!view.canPreview}
          onChange={(event) => {
            setReason(event.target.value);
            edit();
          }}
        />
      </label>
      <div className="flex gap-2">
        <Button
          disabled={
            !view.canPreview ||
            !supportsVolume(stockId) ||
            !validAmount ||
            !reason.trim() ||
            reason.includes('\0')
          }
          onClick={() => inventory.previewUse(stockId, amount, reason)}
        >
          Preview use
        </Button>
        {(view.preview || view.pending === 'preview') && (
          <Button onClick={inventory.closePreview}>Close preview</Button>
        )}
      </div>
      {view.snapshot.snapshot.header.permission === 'read' && (
        <p className="text-sm text-fg-muted">Your current permission allows viewing only.</p>
      )}
      {view.preview?.kind === 'ready' && proposed && (
        <div
          data-testid="organization-inventory-proposed"
          data-preview-handle-id={view.preview.previewHandleId}
          className="space-y-1 rounded border border-accent p-3"
        >
          <h3 className="font-medium">Proposed use · Not recorded</h3>
          <p>Proposed remaining quantity: {inventoryAmountLabel(proposed.quantity)}</p>
          <p className="text-sm text-fg-muted">
            Confirmed inventory remains at revision {state.revision}. This preview records no use.
          </p>
          <p className="text-sm">Record use only for work you have completed.</p>
          <Button disabled={!view.canPreview} onClick={() => void inventory.submit()}>
            Record use
          </Button>
        </div>
      )}
      {view.preview?.kind === 'blocked' && (
        <Notice tone="warning">
          {view.preview.preview.issues.map((issue) => issue.message).join(' ')}
        </Notice>
      )}
      {view.preview?.kind === 'expired' && (
        <Notice tone="neutral">
          This preview expired. Preview again before relying on its proposed quantity.
        </Notice>
      )}
    </section>
  );
}

function OrganizationAttemptStatus({
  inventory,
}: {
  inventory: ReturnType<typeof useInventoryOrganization>;
}) {
  const status = inventory.attempt;
  if (!status) return null;
  const check = <Button onClick={inventory.checkStatus}>Check status</Button>;
  let content;
  let original;
  if (status.kind === 'loading' || status.kind === 'busy')
    content = (
      <p role="status">
        {status.kind === 'loading'
          ? 'Checking retained inventory reports…'
          : 'Checking or recording the original report…'}
      </p>
    );
  else if (status.kind === 'failed')
    content = (
      <>
        <h2 className="font-medium">Retained report status unavailable</h2>
        <p>{status.message}</p>
        {check}
      </>
    );
  else if (status.kind === 'unknown') {
    original = status.attempt;
    content = (
      <>
        <h2 className="font-medium">Outcome not confirmed</h2>
        <p>{status.message}</p>
        <div className="flex gap-2">
          {check}
          <Button onClick={() => void inventory.recover('retry-exact')}>
            Retry original request
          </Button>
        </div>
      </>
    );
  } else {
    const value = status.value;
    if (value.kind === 'none' || value.kind === 'unavailable') return null;
    original = value.attempt;
    if (value.kind === 'never-sent')
      content = (
        <>
          <h2 className="font-medium">Original report saved on this desktop</h2>
          <p>It has not been sent. Confirm the original report to send it.</p>
          <div className="flex gap-2">
            <Button onClick={() => void inventory.recover('confirm-unsent')}>
              Confirm original report
            </Button>
            {check}
          </div>
        </>
      );
    else if (value.kind === 'sent-unknown')
      content = (
        <>
          <h2 className="font-medium">Outcome not confirmed</h2>
          <p>
            The original report may have reached the server. Keep this request while checking its
            outcome.
          </p>
          <div className="flex gap-2">
            {check}
            <Button onClick={() => void inventory.recover('retry-exact')}>
              Retry original request
            </Button>
          </div>
        </>
      );
    else if (value.kind === 'accepted')
      content = (
        <>
          <h2 className="font-medium">Use recorded</h2>
          {value.delivery.kind === 'pending' ? (
            <>
              <p>Inventory refresh pending. Do not record this use again.</p>
              <Button onClick={() => void inventory.recover('inspect')}>Refresh inventory</Button>
            </>
          ) : (
            <>
              <p>Confirmed through inventory revision {value.delivery.confirmedRevision}.</p>
              <Button onClick={inventory.startAnotherUse}>Preview another use</Button>
            </>
          )}
        </>
      );
    else
      content = (
        <>
          <h2 className="font-medium">Use was not recorded</h2>
          <p>{value.disposition.message}</p>
          <Button onClick={inventory.startAnotherUse}>Start a new preview</Button>
        </>
      );
  }
  const action = original?.request.body.action;
  const snapshot = inventory.view.kind === 'visible' ? inventory.view.snapshot : null;
  const currentState =
    snapshot &&
    original &&
    snapshot.binding.target.orgId === original.target.orgId &&
    snapshot.binding.target.inventoryId === original.target.inventoryId
      ? snapshot.snapshot.state
      : null;
  const source = action?.kind === 'consume' ? currentState?.stocks[action.stockId] : undefined;
  const vessel = source ? currentState?.vessels[source.vesselId] : undefined;
  return (
    <section
      data-testid="organization-inventory-attempt"
      data-operation-id={original?.operationId}
      data-request-sha256={original?.requestSha256}
      className="mb-5 space-y-2 rounded border border-border p-4 text-sm"
    >
      {content}
      {inventory.attemptFailure && <Notice tone="warning">{inventory.attemptFailure}</Notice>}
      {original && (
        <details>
          <summary>Original report details</summary>
          {action?.kind === 'consume' ? (
            <dl className="mt-2 space-y-1" data-original-stock-id={action.stockId}>
              <div>
                <dt className="inline font-medium">Amount to use: </dt>
                <dd className="inline">{inventoryAmountLabel(action.quantity)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">
                  {vessel ? 'Current container: ' : 'Recorded stock reference: '}
                </dt>
                <dd className="inline" title={action.stockId}>
                  {vessel?.name ??
                    (action.stockId.length > 24
                      ? `${action.stockId.slice(0, 12)}…${action.stockId.slice(-8)}`
                      : action.stockId)}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Reason: </dt>
                <dd className="inline">{action.reason}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Saved on this desktop: </dt>
                <dd className="inline">{new Date(original.createdAt).toLocaleString()}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2">
              The original inventory report is retained. Check its status before continuing.
            </p>
          )}
        </details>
      )}
    </section>
  );
}
