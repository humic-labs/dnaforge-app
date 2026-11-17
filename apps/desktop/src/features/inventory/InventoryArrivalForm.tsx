import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  type InventoryAmountUnit,
  type InventoryArrival,
  type InventoryArrivalDocumentRead,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import type { InventoryClient, InventoryMaterial } from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { PhysicalField } from './InventoryPhysicalControls';
import {
  destinationPositions,
  inventoryAmountLabel,
  inventoryAmountUnitOptions,
  locationPath,
} from './inventory-view';
import {
  newArrivalComponent,
  type InventoryArrivalComponentDraft,
} from './inventory-arrival-session';

export type InventoryArrivalDialog = { kind: 'receive-delivery' };

function ArrivalFacts({
  arrival,
  data,
  client,
}: {
  arrival: InventoryArrival;
  data: InventoryData;
  client: InventoryClient;
}) {
  const [document, setDocument] = useState<InventoryArrivalDocumentRead | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scope = `${data.project.projectId}:${data.project.defaultInventoryId}:${arrival.id}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    setDocument(null);
    setFailed(null);
    setPending(false);
  }, [scope]);
  async function readDocument(key: string) {
    const source = arrival.documents.find((item) => item.key === key);
    if (!source) return;
    setPending(true);
    setFailed(null);
    try {
      const result = await client.arrivalDocument({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        arrivalId: arrival.id,
        documentKey: key,
        expectedSha256: source.sha256,
      });
      if (scopeRef.current === scope) setDocument(result);
    } catch (cause) {
      if (scopeRef.current === scope)
        setFailed(
          cause instanceof Error ? cause.message : 'The original document could not be read.'
        );
    } finally {
      if (scopeRef.current === scope) setPending(false);
    }
  }
  return (
    <section
      className="space-y-3"
      data-testid="inventory-arrival-facts"
      data-arrival-id={arrival.id}
    >
      <p className="break-all text-xs">
        Delivery: {arrival.identity.namespace} / {arrival.identity.arrivalId}
      </p>
      <p>Supplier: {arrival.supplier ?? 'Unknown'}</p>
      <p className="text-xs">
        Recorded {new Date(arrival.at).toISOString()} ·{' '}
        {arrival.by.kind === 'imported' ? 'Imported arrival evidence' : 'Local arrival record'}
      </p>
      <p className="text-xs">
        Observed scope: {arrival.scope.kind} · {arrival.scope.reason}
      </p>
      {arrival.packages.map((item) => (
        <p key={item.key} className="text-xs">
          Package: {item.label} · Packaging batch: {item.packagingBatch ?? 'Unrecorded'}
        </p>
      ))}
      {arrival.components.map((component) => {
        const stock = component.target.stockId ? data.state.stocks[component.target.stockId] : null;
        return (
          <article
            key={component.key}
            className="space-y-1 rounded border border-border p-3"
            data-arrival-component={component.key}
          >
            <h4 className="text-sm font-semibold">{component.label}</h4>
            <p className="text-xs">
              Disposition: {component.choice.kind} · Component batch:{' '}
              {component.componentBatch ?? 'Unrecorded'}
            </p>
            {component.receivedQuantity ? (
              <p data-original-received-quantity>
                Original received amount: {inventoryAmountLabel(component.receivedQuantity)}
              </p>
            ) : null}
            {stock ? (
              <p data-current-remaining-quantity>
                Current remaining amount: {inventoryAmountLabel(stock.quantity)}
              </p>
            ) : null}
            {stock ? (
              <p className="text-xs">
                Current stock quality: {stock.quality} · Current container:{' '}
                {data.state.vessels[stock.vesselId]?.name ?? stock.vesselId}
              </p>
            ) : null}
          </article>
        );
      })}
      {arrival.documents.map((source) => (
        <div key={source.key} className="space-y-1 text-xs">
          <p className="break-all">
            Document {source.key} · {source.coverage.kind} · {source.sha256} · {source.byteLength}{' '}
            bytes
          </p>
          {source.coverage.kind === 'excerpt' ? (
            <p>Excerpt scope: {source.coverage.reason}</p>
          ) : null}
          <Button
            disabled={pending || !data.state.arrivals[arrival.id]}
            onClick={() => void readDocument(source.key)}
          >
            Read retained document {source.key}
          </Button>
        </div>
      ))}
      {failed ? <Notice tone="error">{failed}</Notice> : null}
      {document?.kind === 'unavailable' ? (
        <Notice>{document.message}</Notice>
      ) : document?.kind === 'available' ? (
        <div className="space-y-2">
          <p className="text-xs">
            Original retained {document.document.coverage.kind} · {document.document.mediaType}
          </p>
          {document.body.encoding === 'utf8' ? (
            <TextArea
              readOnly
              aria-label="Retained original delivery document"
              value={document.body.value}
              rows={8}
            />
          ) : (
            <Notice>
              The retained original is a binary document. Its hash and byte length are shown above.
            </Notice>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function InventoryArrivalForm({
  data,
  status,
  controller,
  client,
  onClose,
}: {
  data: InventoryData;
  status: InventoryControllerState;
  controller: InventoryController;
  client: InventoryClient;
  onClose(): void;
}) {
  const session = controller.arrivalSession({
    project: data.project.projectId,
    inventoryId: data.project.defaultInventoryId,
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { draft } = snapshot;
  const [query, setQuery] = useState('');
  const [materials, setMaterials] = useState<readonly InventoryMaterial[]>([]);
  const [searchFailure, setSearchFailure] = useState<string | null>(null);
  const locked =
    snapshot.phase === 'previewing' ||
    status.kind === 'submitting' ||
    status.kind === 'outcome-unknown' ||
    status.kind === 'committed-refresh-failed';
  const editable = inventoryCanEdit(status);
  const preview = snapshot.phase === 'previewed' ? snapshot.preview : null;
  const stale = Boolean(
    preview &&
    (preview.target.projectId !== data.project.projectId ||
      preview.target.inventoryId !== data.project.defaultInventoryId ||
      preview.target.revision !== data.state.revision)
  );
  const canApply = preview?.kind === 'ready' && !stale && editable;
  const edit = (change: Partial<typeof draft>) => session.edit({ ...draft, ...change });
  const editComponent = (key: string, change: Partial<InventoryArrivalComponentDraft>) =>
    edit({
      components: draft.components.map((component) =>
        component.key === key ? { ...component, ...change } : component
      ),
    });
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .materials({ project: data.project.projectId, query, limit: 100 })
        .then((page) => {
          if (!cancelled) {
            setMaterials(page.items);
            setSearchFailure(null);
          }
        })
        .catch(() => {
          if (!cancelled) setSearchFailure('Current scientific materials could not be searched.');
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, data.project.projectId, query]);
  async function apply() {
    if (!canApply || snapshot.phase !== 'previewed' || snapshot.preview.kind !== 'ready') return;
    if (
      await controller.receiveArrival(
        snapshot.input.sourceText,
        snapshot.preview.options,
        snapshot.preview.planDigest
      )
    )
      onClose();
  }
  return (
    <InventoryPhysicalDialog
      title="Receive delivery"
      subtitle={data.project.name}
      controller={controller}
      status={status}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void apply();
      }}
      submitLabel="Receive delivery atomically"
      disabled={!canApply}
    >
      <div
        className="space-y-5"
        data-testid="inventory-arrival-form"
        data-preview-state={stale ? 'stale' : (preview?.kind ?? snapshot.phase)}
      >
        <p className="text-sm">
          Record actual arriving material with its original document and an explicit decision for
          every listed component. New supplier lots await local assessment; receiving does not
          release them for use.
        </p>
        <fieldset className="space-y-4" disabled={locked || !editable}>
          <div className="grid grid-cols-2 gap-3">
            <PhysicalField label="Delivery namespace">
              <TextField
                aria-label="Delivery namespace"
                value={draft.namespace}
                onChange={(event) => edit({ namespace: event.target.value })}
              />
            </PhysicalField>
            <PhysicalField label="Actual delivery ID">
              <TextField
                aria-label="Actual delivery ID"
                value={draft.deliveryId}
                onChange={(event) => edit({ deliveryId: event.target.value })}
              />
            </PhysicalField>
          </div>
          {Object.values(data.state.arrivals).some(
            (arrival) =>
              arrival.identity.namespace === draft.namespace &&
              arrival.identity.arrivalId === draft.deliveryId
          ) ? (
            <Button onClick={() => session.newDelivery()}>Start a separate new delivery</Button>
          ) : null}
          <p className="text-xs text-fg-muted">
            This ID identifies this actual arrival, separately from supplier lot, product, order or
            operation IDs. Keep it when presenting the same delivery again. The locally generated ID
            cannot detect a delivery entered under a different ID.
          </p>
          <PhysicalField label="Supplier identity">
            <Select
              ariaLabel="Supplier identity"
              value={draft.supplierKind}
              options={[
                { value: 'known', label: 'Known supplier' },
                { value: 'unknown', label: 'Supplier is unknown' },
              ]}
              onValueChange={(value) => edit({ supplierKind: value as typeof draft.supplierKind })}
            />
          </PhysicalField>
          <PhysicalField label="Supplier">
            <TextField
              aria-label="Supplier"
              value={draft.supplier}
              onChange={(event) => edit({ supplier: event.target.value })}
            />
          </PhysicalField>
          <PhysicalField label="Arrival observation reason">
            <TextArea
              aria-label="Arrival observation reason"
              value={draft.observationReason}
              onChange={(event) => edit({ observationReason: event.target.value })}
            />
          </PhysicalField>
          <p className="text-xs">
            Actual observation time is unknown in this receiving form. Native recording time is
            retained separately.
          </p>
          <PhysicalField label="Observed component scope">
            <Select
              ariaLabel="Observed component scope"
              value={draft.scopeKind}
              options={[
                { value: 'selected-components', label: 'Selected components only' },
                {
                  value: 'complete-listed-manifest',
                  label: 'Every component in this listed manifest',
                },
              ]}
              onValueChange={(value) => edit({ scopeKind: value as typeof draft.scopeKind })}
            />
          </PhysicalField>
          <PhysicalField label="Component scope reason">
            <TextArea
              aria-label="Component scope reason"
              value={draft.scopeReason}
              onChange={(event) => edit({ scopeReason: event.target.value })}
            />
          </PhysicalField>
          <PhysicalField label="Original supplier document text">
            <TextArea
              aria-label="Original supplier document text"
              value={draft.documentText}
              onChange={(event) => edit({ documentText: event.target.value })}
              rows={6}
            />
          </PhysicalField>
          <PhysicalField label="Document coverage">
            <Select
              ariaLabel="Document coverage"
              value={draft.documentCoverage}
              options={[
                { value: '', label: 'Choose full document or excerpt' },
                { value: 'full', label: 'Full original text document' },
                { value: 'excerpt', label: 'Explicitly labeled text excerpt' },
              ]}
              onValueChange={(value) =>
                edit({ documentCoverage: value as typeof draft.documentCoverage })
              }
            />
          </PhysicalField>
          {draft.documentCoverage === 'excerpt' ? (
            <PhysicalField label="Excerpt scope reason">
              <TextArea
                aria-label="Excerpt scope reason"
                value={draft.excerptReason}
                onChange={(event) => edit({ excerptReason: event.target.value })}
              />
            </PhysicalField>
          ) : null}
          <Notice>
            Retain exact text and newlines. A text excerpt does not establish possession of a full
            supplier PDF. Supplier QC or dates do not become local quality or expiry decisions.
          </Notice>
          <details>
            <summary className="text-sm">Optional package grouping</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <PhysicalField label="Package label">
                <TextField
                  aria-label="Package label"
                  value={draft.packageLabel}
                  onChange={(event) => edit({ packageLabel: event.target.value })}
                />
              </PhysicalField>
              <PhysicalField label="Packaging batch">
                <TextField
                  aria-label="Packaging batch"
                  value={draft.packagingBatch}
                  onChange={(event) => edit({ packagingBatch: event.target.value })}
                />
              </PhysicalField>
            </div>
            <p className="mt-2 text-xs">
              Grouping describes this delivery, not the current storage location. Packaging and
              component batches stay separate.
            </p>
          </details>
          <PhysicalField label="Find scientific material">
            <TextField
              aria-label="Find scientific material"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </PhysicalField>
          {searchFailure ? <Notice tone="error">{searchFailure}</Notice> : null}
          {draft.components.map((component, index) => {
            const prefix = `Component ${index + 1}`;
            const physical =
              component.disposition === 'identified' ||
              component.disposition === 'unidentified-physical' ||
              component.disposition === 'unobserved-physical';
            const storage = data.state.storage[component.storageId];
            const lots = Object.values(data.state.lots).filter(
              (lot) => lot.materialId === component.materialId
            );
            return (
              <section
                key={component.key}
                className="space-y-3 rounded border border-border p-4"
                data-component-key={component.key}
              >
                <h3 className="font-semibold">{prefix}</h3>
                <PhysicalField label={`${prefix} label`}>
                  <TextField
                    aria-label={`${prefix} label`}
                    value={component.label}
                    onChange={(event) =>
                      editComponent(component.key, { label: event.target.value })
                    }
                  />
                </PhysicalField>
                <PhysicalField label={`${prefix} batch`}>
                  <TextField
                    aria-label={`${prefix} batch`}
                    value={component.componentBatch}
                    onChange={(event) =>
                      editComponent(component.key, { componentBatch: event.target.value })
                    }
                  />
                </PhysicalField>
                <PhysicalField label={`${prefix} disposition`}>
                  <Select
                    ariaLabel={`${prefix} disposition`}
                    value={component.disposition}
                    options={[
                      { value: 'identified', label: 'Identified material physically received' },
                      {
                        value: 'unidentified-physical',
                        label: 'Physical vial with unidentified contents',
                      },
                      {
                        value: 'unobserved-physical',
                        label: 'Physical vial; contents not observed',
                      },
                      { value: 'observed-missing', label: 'Listed component observed missing' },
                      { value: 'evidence-only', label: 'Label or evidence only; no physical vial' },
                    ]}
                    onValueChange={(value) =>
                      editComponent(component.key, {
                        disposition: value as typeof component.disposition,
                      })
                    }
                  />
                </PhysicalField>
                {component.disposition === 'identified' ? (
                  <>
                    <PhysicalField label={`${prefix} material`}>
                      <Select
                        ariaLabel={`${prefix} material`}
                        value={component.materialId}
                        options={[
                          { value: '', label: 'Choose current scientific material' },
                          ...materials.map((material) => ({
                            value: material.id,
                            label: material.name,
                            description: material.registryId ?? material.id,
                          })),
                        ]}
                        onValueChange={(value) =>
                          editComponent(component.key, { materialId: value, lotId: '' })
                        }
                      />
                    </PhysicalField>
                    <PhysicalField label={`${prefix} lot selection`}>
                      <Select
                        ariaLabel={`${prefix} lot selection`}
                        value={component.lotKind}
                        options={[
                          { value: 'new', label: 'Create a managed, unassessed supplier lot' },
                          { value: 'existing', label: 'Select an existing matching-material lot' },
                          {
                            value: 'unattributed',
                            label: 'Supplier lot is unknown; retain unattributed stock',
                          },
                        ]}
                        onValueChange={(value) =>
                          editComponent(component.key, {
                            lotKind: value as typeof component.lotKind,
                          })
                        }
                      />
                    </PhysicalField>
                    {component.lotKind === 'unattributed' ? (
                      <Notice>
                        Material identity is known while its supplier lot remains unattributed. No
                        lot will be invented.
                      </Notice>
                    ) : component.lotKind === 'existing' ? (
                      <PhysicalField label={`${prefix} existing lot`}>
                        <Select
                          ariaLabel={`${prefix} existing lot`}
                          value={component.lotId}
                          options={[
                            { value: '', label: 'Choose an existing lot' },
                            ...lots.map((lot) => ({ value: lot.id, label: lot.name })),
                          ]}
                          onValueChange={(value) => editComponent(component.key, { lotId: value })}
                        />
                      </PhysicalField>
                    ) : (
                      <>
                        <PhysicalField label={`${prefix} new lot name`}>
                          <TextField
                            aria-label={`${prefix} new lot name`}
                            value={component.lotName}
                            onChange={(event) =>
                              editComponent(component.key, { lotName: event.target.value })
                            }
                          />
                        </PhysicalField>
                        <PhysicalField label={`${prefix} management reason`}>
                          <TextArea
                            aria-label={`${prefix} management reason`}
                            value={component.managementReason}
                            onChange={(event) =>
                              editComponent(component.key, { managementReason: event.target.value })
                            }
                          />
                        </PhysicalField>
                      </>
                    )}
                    {component.lotKind !== 'new' ? (
                      <PhysicalField label={`${prefix} lot attribution reason`}>
                        <TextArea
                          aria-label={`${prefix} lot attribution reason`}
                          value={component.lotReason}
                          onChange={(event) =>
                            editComponent(component.key, { lotReason: event.target.value })
                          }
                        />
                      </PhysicalField>
                    ) : null}
                    <div className="grid grid-cols-3 gap-3">
                      <PhysicalField label={`${prefix} amount knowledge`}>
                        <Select
                          ariaLabel={`${prefix} amount knowledge`}
                          value={component.quantityKind}
                          options={[
                            { value: 'known', label: 'Measured amount' },
                            { value: 'unknown', label: 'Unknown amount with explicit unit' },
                          ]}
                          onValueChange={(value) =>
                            editComponent(component.key, {
                              quantityKind: value as typeof component.quantityKind,
                            })
                          }
                        />
                      </PhysicalField>
                      {component.quantityKind === 'known' ? (
                        <PhysicalField label={`${prefix} measured amount`}>
                          <TextField
                            aria-label={`${prefix} measured amount`}
                            value={component.quantity}
                            onChange={(event) =>
                              editComponent(component.key, { quantity: event.target.value })
                            }
                          />
                        </PhysicalField>
                      ) : null}
                      <PhysicalField label={`${prefix} unit`}>
                        <Select
                          ariaLabel={`${prefix} unit`}
                          value={component.unit}
                          options={inventoryAmountUnitOptions()}
                          onValueChange={(value) =>
                            editComponent(component.key, { unit: value as InventoryAmountUnit })
                          }
                        />
                      </PhysicalField>
                    </div>
                    <PhysicalField label={`${prefix} amount reason`}>
                      <TextArea
                        aria-label={`${prefix} amount reason`}
                        value={component.quantityReason}
                        onChange={(event) =>
                          editComponent(component.key, { quantityReason: event.target.value })
                        }
                      />
                    </PhysicalField>
                    <PhysicalField label={`${prefix} local stock quality`}>
                      <Select
                        ariaLabel={`${prefix} local stock quality`}
                        value={component.quality}
                        options={[
                          { value: '', label: 'Choose local stock quality' },
                          {
                            value: 'usable',
                            label: 'Usable stock; lot assessment remains separate',
                          },
                          { value: 'quarantined', label: 'Quarantined stock' },
                        ]}
                        onValueChange={(value) =>
                          editComponent(component.key, {
                            quality: value as typeof component.quality,
                          })
                        }
                      />
                    </PhysicalField>
                    <PhysicalField label={`${prefix} local quality reason`}>
                      <TextArea
                        aria-label={`${prefix} local quality reason`}
                        value={component.qualityReason}
                        onChange={(event) =>
                          editComponent(component.key, { qualityReason: event.target.value })
                        }
                      />
                    </PhysicalField>
                  </>
                ) : (
                  <PhysicalField label={`${prefix} disposition reason`}>
                    <TextArea
                      aria-label={`${prefix} disposition reason`}
                      value={component.dispositionReason}
                      onChange={(event) =>
                        editComponent(component.key, { dispositionReason: event.target.value })
                      }
                    />
                  </PhysicalField>
                )}
                {physical ? (
                  <>
                    <PhysicalField label={`${prefix} container name`}>
                      <TextField
                        aria-label={`${prefix} container name`}
                        value={component.vesselName}
                        onChange={(event) =>
                          editComponent(component.key, { vesselName: event.target.value })
                        }
                      />
                    </PhysicalField>
                    <PhysicalField label={`${prefix} location`}>
                      <Select
                        ariaLabel={`${prefix} location`}
                        value={component.storageId}
                        options={[
                          { value: '', label: 'Unplaced' },
                          ...Object.values(data.state.storage)
                            .filter(
                              (item) =>
                                item.lifecycle === 'active' &&
                                item.layout.kind !== 'fixed-well' &&
                                item.layout.kind !== 'stack'
                            )
                            .map((item) => ({
                              value: item.id,
                              label: locationPath(data.state, item.id),
                            })),
                        ]}
                        onValueChange={(value) =>
                          editComponent(component.key, { storageId: value, position: '' })
                        }
                      />
                    </PhysicalField>
                    {storage ? (
                      <PhysicalField label={`${prefix} position`}>
                        <Select
                          ariaLabel={`${prefix} position`}
                          value={component.position}
                          options={[
                            { value: '', label: 'Choose an exact available position' },
                            ...destinationPositions(data.state, storage).map((value) => ({
                              value,
                              label: value,
                            })),
                          ]}
                          onValueChange={(value) =>
                            editComponent(component.key, { position: value })
                          }
                        />
                      </PhysicalField>
                    ) : null}
                  </>
                ) : (
                  <Notice>
                    This disposition records evidence only and creates no physical stock or vessel.
                  </Notice>
                )}
              </section>
            );
          })}
          <Button
            onClick={() =>
              edit({ components: [...draft.components, newArrivalComponent(crypto.randomUUID())] })
            }
          >
            Add another listed component
          </Button>
          <Button
            onClick={() => {
              if (status.kind === 'refused' || status.kind === 'conflict') controller.dismiss();
              void session.preview();
            }}
          >
            Preview complete delivery
          </Button>
        </fieldset>
        {snapshot.phase === 'failed' ? <Notice tone="error">{snapshot.message}</Notice> : null}
        {stale ? (
          <Notice>
            The inventory changed. Preview this exact delivery again before receiving.
          </Notice>
        ) : null}
        {preview?.kind === 'blocked' ? (
          <div className="space-y-2" data-testid="inventory-arrival-issues">
            {preview.issues.map((issue, index) => (
              <Notice key={index} tone="error">
                {issue.message}
              </Notice>
            ))}
          </div>
        ) : null}
        {preview?.kind === 'ready' ? (
          <Notice>
            Ready to receive every listed disposition atomically. New lots remain unassessed; no
            supplier claim releases stock.
          </Notice>
        ) : null}
        {preview?.kind === 'no-change' ? (
          <Notice>
            This delivery is already recorded. No stock will be received or replenished.
          </Notice>
        ) : null}
        {preview && preview.kind !== 'blocked' ? (
          <ArrivalFacts arrival={preview.arrival} data={data} client={client} />
        ) : null}
        <details>
          <summary className="text-sm">
            Previously received deliveries ({Object.keys(data.state.arrivals).length})
          </summary>
          <div className="mt-3 space-y-4">
            {Object.values(data.state.arrivals).map((arrival) => (
              <details key={arrival.id}>
                <summary className="cursor-pointer text-sm">
                  {arrival.supplier} · {arrival.identity.arrivalId}
                </summary>
                <ArrivalFacts arrival={arrival} data={data} client={client} />
              </details>
            ))}
          </div>
        </details>
      </div>
    </InventoryPhysicalDialog>
  );
}
