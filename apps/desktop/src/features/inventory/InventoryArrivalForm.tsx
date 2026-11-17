import { useEffect, useState, useSyncExternalStore } from 'react';
import { type InventoryAmountUnit } from '@waypoint/domain-services';
import { Button, Notice, Select, TextArea, TextField } from '../../components/ui';
import type { InventoryClient, InventoryMaterial } from '../../shared/inventory-client';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
  type InventoryData,
} from './inventory-controller';
import { InventoryPhysicalDialog } from './InventoryPhysicalDialog';
import { InventoryArrivalFacts } from './InventoryArrivalFacts';
import { InventoryArrivalDocuments } from './InventoryArrivalDocuments';
import { InventoryArrivalClaims } from './InventoryArrivalClaims';
import { PhysicalField } from './InventoryPhysicalControls';
import { destinationPositions, inventoryAmountUnitOptions, locationPath } from './inventory-view';
import {
  newArrivalComponent,
  type InventoryArrivalComponentDraft,
} from './inventory-arrival-session';

export type InventoryArrivalDialog = { kind: 'receive-delivery' };

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
  const [claimEditing, setClaimEditing] = useState(false);
  const reading = snapshot.documentRead.kind === 'reading';
  const fileReadBlocked = snapshot.documentRead.kind !== 'idle';
  useEffect(() => () => session.cancelDocumentRead(), [session]);
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
  const canApply =
    preview?.kind === 'ready' && !stale && editable && !fileReadBlocked && !claimEditing;
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
          <fieldset disabled={claimEditing}>
            <InventoryArrivalDocuments draft={draft} session={session} reading={reading} />
          </fieldset>
          {snapshot.documentRead.kind === 'failed' ? (
            <div className="space-y-2">
              <Notice tone="error">{snapshot.documentRead.message}</Notice>
              <Button onClick={() => session.cancelDocumentRead()}>Keep previous document</Button>
            </div>
          ) : null}
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
                    {component.quantityKind === 'known' ? (
                      <>
                        <PhysicalField label={`${prefix} amount basis`}>
                          <Select
                            ariaLabel={`${prefix} amount basis`}
                            value={component.quantityBasis}
                            options={[
                              { value: 'measurement', label: 'Measured locally' },
                              { value: 'supplier-declared', label: 'Supplier-declared quantity' },
                            ]}
                            onValueChange={(value) =>
                              editComponent(component.key, {
                                quantityBasis: value as typeof component.quantityBasis,
                                quantityClaimKey: '',
                              })
                            }
                          />
                        </PhysicalField>
                        {component.quantityBasis === 'supplier-declared' ? (
                          <PhysicalField label={`${prefix} supplier quantity statement`}>
                            <Select
                              ariaLabel={`${prefix} supplier quantity statement`}
                              value={component.quantityClaimKey}
                              options={[
                                { value: '', label: 'Choose this component’s quantity statement' },
                                ...draft.claims.flatMap((claim) =>
                                  claim.subject.kind === 'component' &&
                                  claim.subject.componentKey === component.key &&
                                  claim.claim.kind === 'quantity'
                                    ? [
                                        {
                                          value: claim.key,
                                          label: `${claim.claim.valueLexeme} ${claim.claim.unitText} · ${claim.key}`,
                                        },
                                      ]
                                    : []
                                ),
                              ]}
                              onValueChange={(value) =>
                                editComponent(component.key, { quantityClaimKey: value })
                              }
                            />
                          </PhysicalField>
                        ) : null}
                      </>
                    ) : null}
                    <div className="grid grid-cols-3 gap-3">
                      <PhysicalField label={`${prefix} amount knowledge`}>
                        <Select
                          ariaLabel={`${prefix} amount knowledge`}
                          value={component.quantityKind}
                          options={[
                            {
                              value: 'known',
                              label:
                                component.quantityBasis === 'supplier-declared'
                                  ? 'Supplier-declared amount'
                                  : 'Measured amount',
                            },
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
          <InventoryArrivalClaims
            key={`${data.project.projectId}:${data.project.defaultInventoryId}`}
            draft={draft}
            session={session}
            onEditingChange={setClaimEditing}
            disabled={fileReadBlocked}
          />
          <Button
            disabled={fileReadBlocked || claimEditing}
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
          <InventoryArrivalFacts arrival={preview.arrival} data={data} client={client} />
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
                <InventoryArrivalFacts arrival={arrival} data={data} client={client} />
              </details>
            ))}
          </div>
        </details>
      </div>
    </InventoryPhysicalDialog>
  );
}
