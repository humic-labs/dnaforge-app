import { InventorySavedProductions } from './InventoryScientificProductions';
import { sharedInventoryPendingCoordinator } from './inventory-pending-coordinator';
import { InventoryScientificForm } from './InventoryScientificForm';
import { InventoryStockroomForm } from './InventoryStockroomForm';
import { InventoryArrivalForm } from './InventoryArrivalForm';
import { InventorySavedValueAssociations } from './InventoryRunValueAttributions';
import { InventoryPlatePlans } from './InventoryPlatePlans';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import {
  inventoryStackItems,
  inventoryVesselContentsProjection,
  inventoryStoragePositions,
  inventoryAmountUnitDefinition,
  type InventoryComposition,
  type InventoryCommand,
  type InventoryContribution,
  type InventoryLot,
  type InventorySourceIdentity,
} from '@waypoint/domain-services';
import { Button, Notice, Select, TextField, TextArea } from '../../components/ui';
import { platform } from '../../platform';
import { safeFocus } from '../../shared/utils/safeFocus';
import type { NativeInventoryHistoryEntry } from '../../shared/inventory-command';
import type { InventoryProject } from '../../shared/inventory-client';
import { InventoryController, inventoryData, inventoryCanEdit } from './inventory-controller';
import { InventoryMaterialForm, isInventoryMaterialDialog } from './InventoryMaterialForm';
import { InventoryLotControlsForm, InventoryStockLotControls } from './InventoryLotControlsForm';
import { InventoryOpeningForm, InventoryValidityForm } from './InventoryValidityForms';
import { InventoryValidityPanel, useInventoryValidityRefresh } from './InventoryValidityPanel';
import { InventoryContentsForm } from './InventoryContentsForm';
import { InventoryContentsPanel } from './InventoryContentsPanel';
import { inventoryContentsLabel } from './inventory-contents-view';
import { InventoryForm } from './InventoryForm';
import { InventoryArchiveExportForm, InventoryArchiveImportForm } from './InventoryArchiveForms';
import { InventoryTableForm } from './InventoryTableForm';
import { InventoryStocktakeForm } from './InventoryStocktakeForm';
import { InventorySourceRevisionForm } from './InventorySourceRevisionForm';
import { InventoryHierarchyForm } from './InventoryHierarchyForm';
import { InventoryMappedTableForm } from './InventoryMappedTableForm';
import { InventoryBenchlingCaptureForm } from './InventoryBenchlingCaptureForm';
import { InventoryCompositionForm } from './InventoryCompositionForm';
import { InventoryReservationForm } from './InventoryReservationForm';
import { InventoryCustodyForm } from './InventoryCustodyForm';
import { InventoryCustodyPanel } from './InventoryCustodyPanel';
import { InventoryPhysicalDetails } from './InventoryPhysicalDetails';
import { InventoryPhysicalWorkspace } from './InventoryPhysicalWorkspace';
import { InventoryItemCodes } from './InventoryItemCodes';
import { InventoryItemCodeForm } from './InventoryItemCodeForm';
import { InventoryLabelForm } from './InventoryLabelForm';
import { InventoryStorageConditions } from './InventoryStorageConditions';
import { InventoryTemperatureForm } from './InventoryTemperatureForm';
import { isInventoryTemperatureDialog } from './inventory-temperature-view';
import { isInventoryItemCodeDialog } from './inventory-item-code-view';
import { isInventoryPhysicalDialog } from './inventory-physical-view';
import {
  InventoryReservationList,
  InventoryStockAvailability,
  isInventoryReservationDialog,
} from './InventoryReservations';
import { InventoryStatusNotice } from './InventoryStatusNotice';
import {
  historyLabel,
  inventoryConcentrationLabel,
  inventoryAmountLabel,
  inventoryStockAction,
  inventoryCustodyLabel,
  inventoryOccupant,
  locationPath,
  stockInSelection,
  vesselLocation,
  type InventoryDialog,
  type InventorySelection,
  type InventoryItem,
} from './inventory-view';

let activeController: InventoryController | undefined;

function sharedController(): InventoryController {
  if (!activeController) {
    activeController = new InventoryController(
      platform().inventory,
      sharedInventoryPendingCoordinator()
    );
  }
  return activeController;
}

type Drawer =
  | { kind: 'closed' }
  | { kind: 'history' }
  | { kind: 'reservations' }
  | { kind: 'item'; item: InventoryItem }
  | { kind: 'stock'; stockId: string; tab: 'details' | 'history' | 'reservations' };

type InventorySourceKind = Exclude<
  Extract<NativeInventoryHistoryEntry['request'], { kind: string }>['kind'],
  | 'record-scientific-transfer'
  | 'record-scientific-transfer-v2'
  | 'record-scientific-citation'
  | 'withdraw-scientific-citation'
  | 'save-plate-plan-version'
  | 'record-plate-plan-observation'
  | 'record-run-value-attribution'
  | 'withdraw-run-value-attribution'
  | 'record-scientific-production'
>;
const sourceHistoryCopy: Readonly<
  Record<
    InventorySourceKind,
    {
      title: string;
      summary: string;
      sourceLabel: string;
      choicesLabel: string;
      description: string;
    }
  >
> = {
  'adopt-archive': {
    title: 'Adopted inventory archive',
    summary: 'Retained source archive',
    sourceLabel: 'Retained imported archive',
    choicesLabel: '',
    description:
      'Original source history remains in this archive. This operation records adoption in the destination.',
  },
  'receive-arrival': {
    title: 'Received actual delivery',
    summary: 'Retained original delivery admission',
    sourceLabel: 'Original delivery source packet',
    choicesLabel: 'Original delivery resolutions',
    description:
      'This operation retains the original supplier document, actual delivery identity and explicit component dispositions. Later use never replenishes a previously recorded arrival.',
  },
  'receive-table': {
    title: 'Received inventory table',
    summary: 'Retained source table',
    sourceLabel: 'Retained receive table',
    choicesLabel: 'Retained table receiving choices',
    description:
      'Original table text and explicit choices are retained with this atomic receiving operation.',
  },
  'apply-stocktake': {
    title: 'Recorded stocktake observations',
    summary: 'Retained stocktake source',
    sourceLabel: 'Retained stocktake source',
    choicesLabel: 'Retained stocktake choices',
    description:
      'Original stocktake text and explicit record or correction choices are retained with this operation.',
  },
  'acknowledge-table-source': {
    title: 'Acknowledged source revision',
    summary: 'Retained revised source',
    sourceLabel: 'Retained revised source',
    choicesLabel: 'Retained source revision choices',
    description:
      'The revised source, verified previous source fields and acknowledgement reasons are retained. This operation changes no physical inventory facts.',
  },
  'import-hierarchy': {
    title: 'Imported inventory hierarchy',
    summary: 'Retained hierarchy source',
    sourceLabel: 'Retained hierarchy source',
    choicesLabel: 'Retained hierarchy choices',
    description:
      'Original hierarchy text and explicit layout, parent and skip choices are retained with this atomic import.',
  },
  'import-benchling-capture': {
    title: 'Imported Benchling physical inventory',
    summary: 'Retained original Benchling capture',
    sourceLabel: 'Retained Benchling physical capture',
    choicesLabel: 'Retained Benchling physical interpretation',
    description:
      'Original response bodies, source identities, layout and placement evidence, scientific bindings, quantity interpretations and contents decisions are retained with this single atomic import.',
  },
  'receive-mapped-table': {
    title: 'Received mapped spreadsheet',
    summary: 'Retained original spreadsheet',
    sourceLabel: 'Retained original spreadsheet',
    choicesLabel: 'Retained mapped spreadsheet choices',
    description:
      'The complete original spreadsheet, evidence-only columns and explicit scientific, plate, position, quantity and quality decisions are retained with this atomic receiving operation.',
  },
};

function compositionValues(
  composition: InventoryComposition,
  names: Readonly<Record<string, string>>
) {
  if (composition.kind === 'unknown') return <p>Unknown composition</p>;
  const analytes = Object.entries(composition.analytes);
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">Homogeneous</p>
      {analytes.length ? (
        <ul className="space-y-2">
          {analytes.map(([id, concentration]) => (
            <li key={id} data-analyte-id={id} className="break-words">
              <span className="block text-xs text-fg-muted">{names[id] ?? id}</span>
              <span className="tabular-nums">{inventoryConcentrationLabel(concentration)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-muted">No analyte measurements recorded.</p>
      )}
      <p className="text-xs text-fg-muted">Unlisted analytes are unmeasured.</p>
    </div>
  );
}

function lotInputs(
  lot: InventoryLot | undefined
): readonly (InventorySourceIdentity | InventoryContribution)[] {
  if (!lot || lot.origin.kind === 'received') return [];
  return lot.origin.kind === 'diluted'
    ? [lot.origin.sample, lot.origin.diluent]
    : lot.origin.inputs;
}

export function InventoryPanel() {
  const controller = useMemo(sharedController, []);
  const { projects, status, projectsError, catalog, itemCodeLookup } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );
  const data = inventoryData(status);
  useInventoryValidityRefresh(data ?? null, controller);
  const [selection, setSelection] = useState<InventorySelection>({ kind: 'all' });
  const [drawer, setDrawer] = useState<Drawer>({ kind: 'closed' });
  const [dialog, setDialog] = useState<InventoryDialog>({ kind: 'none' });
  const [platePlanProject, setPlatePlanProject] = useState<InventoryProject | null>(null);
  const [valueAssociationProject, setValueAssociationProject] = useState<InventoryProject | null>(
    null
  );
  const [productionProject, setProductionProject] = useState<InventoryProject | null>(null);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(100);
  const [shownPositions, setShownPositions] = useState(200);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [materialNames, setMaterialNames] = useState<Record<string, string>>({});
  const [registryIds, setRegistryIds] = useState<Record<string, string>>({});
  const names = useRef(materialNames);
  names.current = materialNames;
  const state = data?.state;
  const contentsByVessel = useMemo(
    () => (state ? inventoryVesselContentsProjection(state) : {}),
    [state]
  );
  const selectedLocation =
    state && selection.kind === 'location' ? state.storage[selection.id] : undefined;
  const editable = inventoryCanEdit(status);
  const hasLabelSnapshot = (codeId: string) =>
    Boolean(
      data &&
      controller.hasLabelSnapshot({
        project: data.project.projectId,
        inventoryId: data.project.defaultInventoryId,
        codeId,
      })
    );
  const selectedStock = state && drawer.kind === 'stock' ? state.stocks[drawer.stockId] : undefined;
  const selectedLotConstraints = selectedStock?.lotConstraints;
  const selectedValidityRoots = selectedStock
    ? (data?.availability?.stocks[selectedStock.id]?.validity?.families.map(
        (family) => family.rootId
      ) ?? [])
    : [];
  const reserveBlocked =
    !data ||
    !selectedStock ||
    inventoryStockAction(data, selectedStock.id, 'reserve')?.kind !== 'allowed';
  const withdrawBlocked =
    !data ||
    !selectedStock ||
    inventoryStockAction(data, selectedStock.id, 'withdraw')?.kind !== 'allowed';
  const selectedVessel = state && selectedStock ? state.vessels[selectedStock.vesselId] : undefined;
  const selectedItem =
    state && drawer.kind === 'item'
      ? drawer.item.kind === 'storage'
        ? state.storage[drawer.item.id]
        : state.vessels[drawer.item.id]
      : undefined;
  const selectedLot =
    state && selectedStock?.source.kind === 'lot'
      ? state.lots[selectedStock.source.lotId]
      : undefined;
  const selectedInputs = lotInputs(selectedLot);
  const title =
    selectedLocation?.name ??
    (selection.kind === 'unplaced'
      ? 'Unplaced stock'
      : selection.kind === 'disposed'
        ? 'Disposed stock'
        : 'All stock');
  const currentProjectId =
    data?.project.projectId ?? ('project' in status ? status.project?.projectId : '') ?? '';
  useEffect(() => {
    if (currentProjectId && platePlanProject?.projectId !== currentProjectId)
      setPlatePlanProject(null);
  }, [currentProjectId, platePlanProject]);
  useEffect(() => {
    if (currentProjectId && valueAssociationProject?.projectId !== currentProjectId)
      setValueAssociationProject(null);
  }, [currentProjectId, valueAssociationProject]);
  useEffect(() => {
    if (currentProjectId && productionProject?.projectId !== currentProjectId)
      setProductionProject(null);
  }, [currentProjectId, productionProject]);
  const materialProject = useRef(currentProjectId);
  materialProject.current = currentProjectId;
  const stocks = state
    ? Object.values(state.stocks).filter((stock) => {
        const vessel = state.vessels[stock.vesselId];
        return (
          vessel &&
          stockInSelection(state, vessel, selection) &&
          `${materialNames[stock.materialId] ?? ''} ${registryIds[stock.materialId] ?? ''} ${stock.source.kind === 'lot' ? `${stock.source.lotId} ${state.lots[stock.source.lotId].name}` : stock.source.rootStockId} ${stock.id} ${stock.materialId} ${stock.vesselId} ${vessel.name} ${vesselLocation(state, vessel, data?.availability?.items[vessel.id])}`
            .toLowerCase()
            .includes(search.toLowerCase())
        );
      })
    : [];
  const unstockedContainers = state
    ? Object.values(state.vessels).filter(
        (vessel) =>
          vessel.kind === 'movable' &&
          !Object.values(state.stocks).some((stock) => stock.vesselId === vessel.id) &&
          stockInSelection(state, vessel, selection) &&
          `${vessel.name} ${vessel.id} ${vesselLocation(state, vessel, data?.availability?.items[vessel.id])}`
            .toLowerCase()
            .includes(search.toLowerCase())
      )
    : [];
  const visibleStocks = stocks.slice(0, shown);
  const labelIds = [
    ...visibleStocks.map((stock) => stock.materialId),
    ...(selectedStock?.composition.kind === 'homogeneous'
      ? Object.keys(selectedStock.composition.analytes)
      : []),
    ...selectedInputs.flatMap((input) => [
      input.materialId,
      ...(input.composition.kind === 'homogeneous' ? Object.keys(input.composition.analytes) : []),
    ]),
  ];
  const labelKey = [...new Set(labelIds)].sort().join('\n');

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const ids = [...new Set(labelIds)].filter((id) => !names.current[id]);
    void (async () => {
      for (let offset = 0; offset < ids.length && !cancelled; offset += 4) {
        await Promise.all(
          ids.slice(offset, offset + 4).map(async (id) => {
            try {
              const page = await platform().inventory.materials({
                project: data.project.projectId,
                query: id,
                limit: 100,
              });
              const item = page.items.find((item) => item.id === id);
              if (!cancelled && materialProject.current === data.project.projectId) {
                setMaterialNames((current) => ({
                  ...current,
                  [id]: item?.name ?? 'Unavailable material',
                }));
                if (item?.registryId)
                  setRegistryIds((current) => ({ ...current, [id]: item.registryId! }));
              }
            } catch {}
          })
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.project.projectId, labelKey]);

  useEffect(() => {
    if (!data || !search.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void platform()
        .inventory.materials({ project: data.project.projectId, query: search, limit: 100 })
        .then((page) => {
          if (cancelled || materialProject.current !== data.project.projectId) return;
          setMaterialNames((current) => ({
            ...current,
            ...Object.fromEntries(page.items.map((item) => [item.id, item.name])),
          }));
          setRegistryIds((current) => ({
            ...current,
            ...Object.fromEntries(page.items.map((item) => [item.id, item.registryId ?? ''])),
          }));
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [data?.project.projectId, search]);

  useEffect(() => {
    void controller.open();
  }, [controller]);

  useEffect(() => {
    if (!state || drawer.kind !== 'item' || drawer.item.kind !== 'vessel') return;
    const vesselId = drawer.item.id;
    const stock = Object.values(state.stocks).find((stock) => stock.vesselId === vesselId);
    if (stock) setDrawer({ kind: 'stock', stockId: stock.id, tab: 'details' });
  }, [state, drawer]);

  useEffect(() => {
    const refresh = () => {
      void controller.refresh();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [controller]);

  function choose(selection: InventorySelection) {
    setSelection(selection);
    setShown(100);
    setShownPositions(200);
    setDrawer({ kind: 'closed' });
  }

  function openItem(item: InventoryItem) {
    if (item.kind === 'storage') choose({ kind: 'location', id: item.id });
    else {
      const stock =
        state && Object.values(state.stocks).find((stock) => stock.vesselId === item.id);
      setDrawer(
        stock ? { kind: 'stock', stockId: stock.id, tab: 'details' } : { kind: 'item', item }
      );
    }
  }

  const treeRows: { id: string; depth: number; children: boolean }[] = [];
  if (state) {
    const active = Object.values(state.storage).filter((item) => item.lifecycle === 'active');
    const append = (parent: string | null, depth: number) => {
      for (const item of active.filter((item) =>
        parent
          ? item.placement.kind === 'located' && item.placement.storageId === parent
          : item.placement.kind === 'root'
      )) {
        const children = active.some(
          (child) => child.placement.kind === 'located' && child.placement.storageId === item.id
        );
        treeRows.push({ id: item.id, depth, children });
        if (!collapsed.has(item.id)) append(item.id, depth + 1);
      }
    };
    append(null, 1);
  }

  function treeKey(event: KeyboardEvent<HTMLDivElement>, id: string) {
    const nodes = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []
    );
    const index = nodes.indexOf(event.currentTarget);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      safeFocus(
        nodes[Math.max(0, Math.min(nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      );
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setCollapsed((current) => {
        const next = new Set(current);
        if (event.key === 'ArrowLeft') next.add(id);
        else next.delete(id);
        return next;
      });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose({ kind: 'location', id });
    }
  }

  let positions = selectedLocation ? [...inventoryStoragePositions(selectedLocation)] : [];
  if (selectedLocation?.layout.kind === 'stack' && state) {
    const count = inventoryStackItems(state, selectedLocation.id).length;
    positions = positions.slice(0, Math.min(positions.length, count + 1)).reverse();
  }
  const history =
    data?.history.filter(
      (entry) =>
        !selectedStock ||
        'kind' in entry.request ||
        ('commands' in entry.request ? entry.request.commands : [])
          .flatMap<InventoryCommand>((command) =>
            command.kind === 'fulfill-reservations' ? [command, command.withdrawal] : [command]
          )
          .some(
            (command) =>
              (command.kind === 'release-reservation' || command.kind === 'cancel-reservation'
                ? data?.availability?.stocks[selectedStock.id]?.reservationIds.includes(
                    command.reservationId
                  )
                : command.kind === 'expire-reservations'
                  ? command.ids.some((id) =>
                      data?.availability?.stocks[selectedStock.id]?.reservationIds.includes(id)
                    )
                  : command.kind === 'reserve-item'
                    ? data?.availability?.stocks[selectedStock.id]?.reservationIds.includes(
                        command.id
                      )
                    : false) ||
              (command.kind === 'record-validity-decision' &&
                selectedValidityRoots.includes(command.id)) ||
              (command.kind === 'correct-validity-decision' &&
                selectedValidityRoots.includes(
                  state!.validityFacts[command.supersedesId]?.rootId ?? ''
                )) ||
              ('lotId' in command &&
                Boolean(selectedLotConstraints?.lotIds.includes(command.lotId))) ||
              (command.kind === 'withdraw-lot-recall' &&
                Boolean(
                  selectedLotConstraints?.lotIds.includes(
                    state!.lotRecalls[command.recallId]?.lotId
                  )
                )) ||
              ('stockId' in command && command.stockId === selectedStock.id) ||
              (command.kind === 'transfer' &&
                (command.sourceStockId === selectedStock.id ||
                  command.destination.stockId === selectedStock.id)) ||
              (command.kind === 'pool' &&
                command.inputs.some((input) => input.stockId === selectedStock.id)) ||
              (command.kind === 'dilute' &&
                (command.sample.stockId === selectedStock.id ||
                  command.diluent.stockId === selectedStock.id)) ||
              ('vesselId' in command && command.vesselId === selectedStock.vesselId) ||
              ('id' in command && command.id === selectedStock.vesselId) ||
              ('item' in command && command.item.id === selectedStock.vesselId)
          )
    ) ?? [];

  function renderHistory(entries: readonly NativeInventoryHistoryEntry[]) {
    return (
      <div data-testid="inventory-history" className="divide-y divide-border">
        {entries.length === 0 ? (
          <p className="p-4 text-sm text-fg-muted">
            No recorded changes in the latest inventory history.
          </p>
        ) : (
          [...entries].reverse().map((entry) => (
            <article
              key={entry.receipt.operationId}
              data-operation-id={entry.receipt.operationId}
              className="space-y-1.5 p-4 text-sm"
            >
              <p className="font-medium text-fg">
                {'kind' in entry.request
                  ? entry.request.kind === 'record-scientific-production'
                    ? 'Recorded completed manual production'
                    : entry.request.kind === 'record-run-value-attribution'
                      ? 'Associated a saved Run value and recorded subject'
                      : entry.request.kind === 'withdraw-run-value-attribution'
                        ? 'Withdrew a saved value association'
                        : entry.request.kind === 'record-scientific-citation'
                          ? 'Added saved scientific citation'
                          : entry.request.kind === 'withdraw-scientific-citation'
                            ? 'Withdrew scientific citation'
                            : entry.request.kind === 'save-plate-plan-version'
                              ? 'Saved reusable plate-plan version'
                              : entry.request.kind === 'record-plate-plan-observation'
                                ? 'Recorded completed manual plate-plan use'
                                : entry.request.kind === 'record-scientific-transfer' ||
                                    entry.request.kind === 'record-scientific-transfer-v2'
                                  ? 'Recorded observed scientific transfer'
                                  : sourceHistoryCopy[entry.request.kind].title
                  : entry.request.commands
                      .map((command) => (state ? historyLabel(command, state) : ''))
                      .join(' · ')}
              </p>
              {'kind' in entry.request &&
              (entry.request.kind === 'record-scientific-transfer' ||
                entry.request.kind === 'record-scientific-transfer-v2') ? (
                <div className="space-y-1 text-xs">
                  <p>
                    Operator-reported completed manual transfer:{' '}
                    {inventoryAmountLabel(entry.request.choices.quantity)}
                  </p>
                  <p>{entry.request.choices.reason}</p>
                  <p className="break-all">
                    Saved scientific source:{' '}
                    {entry.request.kind === 'record-scientific-transfer'
                      ? entry.request.choices.pageId
                      : entry.request.choices.context.entityId}{' '}
                    ·{' '}
                    {entry.request.kind === 'record-scientific-transfer'
                      ? entry.request.choices.expectedSourceSha256
                      : entry.request.choices.context.sourceSha256}
                  </p>
                  <p>
                    Retained structured context and exact before/after stocks are available in
                    Recorded scientific work.
                  </p>
                </div>
              ) : 'kind' in entry.request &&
                (entry.request.kind === 'record-scientific-citation' ||
                  entry.request.kind === 'withdraw-scientific-citation') ? (
                <div className="space-y-1 text-xs">
                  <p>{entry.request.choices.reason}</p>
                  <p className="break-all">Recorded work: {entry.request.choices.workId}</p>
                  <p className="break-all">
                    {entry.request.kind === 'record-scientific-citation'
                      ? `Saved source: ${entry.request.choices.context.entityId} · ${entry.request.choices.context.sourceSha256}`
                      : `Withdrawn citation: ${entry.request.choices.citationId}`}
                  </p>
                  <p>
                    Original citation details and saved context remain in the recorded work's
                    citation history.
                  </p>
                </div>
              ) : 'kind' in entry.request &&
                entry.request.kind === 'record-plate-plan-observation' ? (
                <div className="space-y-1 text-xs">
                  <p>{entry.request.choices.reason}</p>
                  <p className="break-all">
                    Occurrence: {entry.request.choices.identity.observationId}
                  </p>
                  <p className="break-all">Saved plan: {entry.request.choices.binding.versionId}</p>
                  <p>
                    One operator-reported whole manual use with its recorded stock effects and saved
                    scientific context.
                  </p>
                </div>
              ) : 'kind' in entry.request &&
                (entry.request.kind === 'record-run-value-attribution' ||
                  entry.request.kind === 'withdraw-run-value-attribution') ? (
                <div className="space-y-1 text-xs">
                  <p>{entry.request.choices.reason}</p>
                  <p>
                    Original values, subjects, and withdrawal history remain available in Saved
                    value associations.
                  </p>
                </div>
              ) : 'kind' in entry.request &&
                entry.request.kind === 'record-scientific-production' ? (
                <div className="space-y-1 text-xs">
                  <p>{entry.request.choices.output.lotName}</p>
                  <p>{entry.request.choices.reason}</p>
                  <p>
                    Original production, stock effects and saved design are available in Saved
                    productions.
                  </p>
                </div>
              ) : 'kind' in entry.request && entry.request.kind === 'save-plate-plan-version' ? (
                <div className="space-y-1 text-xs">
                  <p>{entry.request.choices.definition.title}</p>
                  <p>{entry.request.choices.reason}</p>
                  <p>Reusable instructions saved independently of physical inventory.</p>
                  <details>
                    <summary>Saved definition</summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                      {JSON.stringify(entry.request.choices, null, 2)}
                    </pre>
                  </details>
                </div>
              ) : 'kind' in entry.request ? (
                <details
                  className="space-y-2 text-xs"
                  data-testid="inventory-imported-source-evidence"
                >
                  <summary className="cursor-pointer text-accent">
                    {sourceHistoryCopy[entry.request.kind].summary}
                  </summary>
                  <p>{sourceHistoryCopy[entry.request.kind].description}</p>
                  <p className="break-all">Plan: {entry.request.expectedPlanDigest}</p>
                  <TextArea
                    readOnly
                    aria-label={sourceHistoryCopy[entry.request.kind].sourceLabel}
                    value={entry.request.sourceText}
                    className="h-40 font-mono text-xs"
                  />
                  {entry.request.kind !== 'adopt-archive' ? (
                    <TextArea
                      readOnly
                      aria-label={sourceHistoryCopy[entry.request.kind].choicesLabel}
                      value={JSON.stringify(entry.request.options, null, 2)}
                      className="h-40 font-mono text-xs"
                    />
                  ) : null}
                </details>
              ) : null}
              {('commands' in entry.request ? entry.request.commands : [])
                .flatMap((command) => {
                  const action =
                    command.kind === 'fulfill-reservations' ? command.withdrawal : command;
                  return 'reason' in action ? [action.reason] : [];
                })
                .map((reason, index) => (
                  <p key={index} className="break-words text-xs text-fg-muted">
                    {reason}
                  </p>
                ))}
              {('commands' in entry.request ? entry.request.commands : []).flatMap((command) => {
                command = command.kind === 'fulfill-reservations' ? command.withdrawal : command;
                const lotId =
                  command.kind === 'create-lot'
                    ? command.id
                    : command.kind === 'pool' || command.kind === 'dilute'
                      ? command.lotId
                      : undefined;
                const lot = lotId && state?.lots[lotId];
                return lot && lotInputs(lot).length
                  ? [<div key={lot.id}>{renderContributions(lot)}</div>]
                  : [];
              })}
              <p className="text-xs text-fg-subtle">
                {new Date(entry.receipt.recordedAt).toLocaleString()}
              </p>
            </article>
          ))
        )}
        {data && data.state.revision > 100 ? (
          <p className="p-4 text-xs text-fg-muted">
            Showing changes from the latest 100 inventory updates.
          </p>
        ) : null}
      </div>
    );
  }

  function renderContributions(lot: InventoryLot) {
    const inputs = lotInputs(lot);
    return inputs.length ? (
      <div data-lot-id={lot.id} className="space-y-3">
        <p className="text-xs text-fg-muted">Composition recorded at contribution</p>
        {inputs.map((input, index) => (
          <div
            key={`${input.stockId}:${index}`}
            data-source-stock-id={input.stockId}
            className="space-y-2 rounded border border-border p-3 text-xs"
          >
            <p className="break-words font-medium">
              {materialNames[input.materialId] ?? input.materialId}
            </p>
            <p className="break-words text-fg-muted">
              {input.source.kind === 'lot'
                ? (state?.lots[input.source.lotId]?.name ?? input.source.lotId)
                : 'Unattributed'}
              {'quantity' in input ? ` · ${input.quantity.value} µL` : ''}
            </p>
            {compositionValues(input.composition, materialNames)}
          </div>
        ))}
      </div>
    ) : null;
  }

  return (
    <section
      data-testid="inventory-panel"
      data-state={status.kind}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg text-fg"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold tracking-tight">Inventory</h1>
          <p className="mt-0.5 text-xs text-fg-muted">
            Find stock, track locations, and record use.
          </p>
        </div>
        <div className="w-56">
          <Select
            ariaLabel="Inventory project"
            testId="inventory-project-picker"
            value={currentProjectId}
            options={[
              { value: '', label: 'Choose a project' },
              ...projects.map((project) => ({
                value: project.projectId,
                label: project.name,
                description: project.pinned ? 'Read only' : undefined,
              })),
            ]}
            onValueChange={(id) => {
              setMaterialNames({});
              setRegistryIds({});
              setDialog({ kind: 'none' });
              setPlatePlanProject(null);
              setValueAssociationProject(null);
              setProductionProject(null);
              choose({ kind: 'all' });
              void controller.selectProject(id);
            }}
          />
        </div>
        <Button aria-label="Refresh projects" onClick={() => void controller.refreshProjects()}>
          Refresh
        </Button>
        <Button disabled={!data} onClick={() => setDrawer({ kind: 'history' })}>
          History
        </Button>
        <Button disabled={!data} onClick={() => setDrawer({ kind: 'reservations' })}>
          Reservations
        </Button>
        <Button disabled={!editable} onClick={() => setDialog({ kind: 'lot' })}>
          Add lot
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'scientific-transfer' })}>
          Record scientific transfer
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'stockroom' })}>
          Stockroom
        </Button>
        <Button disabled={!data} onClick={() => data && setPlatePlanProject(data.project)}>
          Plate plans
        </Button>
        <Button disabled={!data} onClick={() => data && setValueAssociationProject(data.project)}>
          Saved value associations
        </Button>
        <Button disabled={!data} onClick={() => data && setProductionProject(data.project)}>
          Saved productions
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'receive-delivery' })}>
          Receive delivery
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'lot-controls' })}>
          Lot quality and recalls
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'validity' })}>
          Validity decisions
        </Button>
        <Button
          disabled={!editable}
          onClick={() =>
            setDialog({
              kind: 'location',
              ...(selectedLocation ? { parentId: selectedLocation.id } : {}),
            })
          }
        >
          Add location
        </Button>
        <Button
          variant="primary"
          disabled={!editable}
          onClick={() => setDialog({ kind: 'receive' })}
        >
          Receive stock
        </Button>
        <Button disabled={!editable} onClick={() => setDialog({ kind: 'container' })}>
          Add container
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'setup' })}>
          Inventory setup
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'export-archive' })}>
          Export inventory
        </Button>
        <Button
          disabled={!data || status.kind === 'submitting' || status.kind === 'outcome-unknown'}
          onClick={() => setDialog({ kind: 'import-archive' })}
        >
          Import archive
        </Button>
        <Button
          disabled={!data || status.kind === 'submitting' || status.kind === 'outcome-unknown'}
          onClick={() => setDialog({ kind: 'receive-table' })}
        >
          Import table
        </Button>
        <Button
          disabled={!data || status.kind === 'submitting' || status.kind === 'outcome-unknown'}
          onClick={() => setDialog({ kind: 'stocktake' })}
        >
          Stocktake
        </Button>
        <Button
          disabled={!data || status.kind === 'submitting' || status.kind === 'outcome-unknown'}
          onClick={() => setDialog({ kind: 'source-revision' })}
        >
          Source revisions
        </Button>
        <Button
          disabled={!data || status.kind === 'submitting' || status.kind === 'outcome-unknown'}
          onClick={() => setDialog({ kind: 'receive-mapped-table' })}
        >
          Map spreadsheet
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'item-code-lookup' })}>
          Scan or enter code
        </Button>
        <Button disabled={!data} onClick={() => setDialog({ kind: 'inspect-benchling-capture' })}>
          Inspect Benchling capture
        </Button>
        <Button
          disabled={!data || status.kind === 'submitting' || status.kind === 'outcome-unknown'}
          onClick={() => setDialog({ kind: 'import-hierarchy' })}
        >
          Import locations
        </Button>
      </header>
      {projectsError ? (
        <div className="px-5 pt-3">
          <Notice tone="error">{projectsError}</Notice>
        </div>
      ) : null}
      {dialog.kind === 'none' ? (
        <div className="empty:hidden px-5 pt-3">
          <InventoryStatusNotice controller={controller} status={status} />
        </div>
      ) : null}
      {data?.project.pinned ? (
        <div className="px-5 pt-3">
          <Notice>This project is read only. You can inspect its inventory and history.</Notice>
        </div>
      ) : null}
      {data?.state.origin.kind === 'archive-adoption' ? (
        <div className="px-5 pt-3" data-testid="inventory-archive-origin">
          <Notice>
            This inventory was created from an archive of revision{' '}
            {data.state.origin.source.revision}.
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer">Source provenance</summary>
              <p className="break-all">
                {data.state.origin.source.projectId} / {data.state.origin.source.inventoryId}
              </p>
              <p className="break-all">{data.state.origin.source.archiveSha256}</p>
              <p>Adopted {new Date(data.state.origin.at).toISOString()}</p>
            </details>
          </Notice>
        </div>
      ) : null}
      {!data ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <h2 className="text-lg font-medium">
              {projects.length
                ? 'Choose an inventory project'
                : status.kind === 'loading'
                  ? 'Loading projects…'
                  : 'Open a project to start inventorying'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-fg-muted">
              Storage locations and physical stock belong to a project. Choose the project you want
              to work in.
            </p>
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-subtle">
            <div className="space-y-1 border-b border-border p-3">
              {(
                [
                  { kind: 'all', label: 'All stock' },
                  { kind: 'unplaced', label: 'Unplaced' },
                  { kind: 'disposed', label: 'Disposed' },
                ] as const
              ).map((item) => (
                <button
                  key={item.kind}
                  onClick={() => choose({ kind: item.kind })}
                  aria-current={selection.kind === item.kind ? 'page' : undefined}
                  className={`w-full rounded px-3 py-2 text-left text-sm hover:bg-bg-muted ${selection.kind === item.kind ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <h2 className="px-4 pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              Storage locations
            </h2>
            <div role="tree" aria-label="Storage locations" className="pb-4">
              {treeRows.map(({ id, depth, children }, index) => (
                <div
                  key={id}
                  role="treeitem"
                  data-location-id={id}
                  aria-level={depth}
                  aria-selected={selection.kind === 'location' && selection.id === id}
                  aria-expanded={children ? !collapsed.has(id) : undefined}
                  tabIndex={
                    (selection.kind === 'location' ? selection.id === id : index === 0) ? 0 : -1
                  }
                  onClick={() => choose({ kind: 'location', id })}
                  onKeyDown={(event) => treeKey(event, id)}
                  className={`flex min-h-9 cursor-pointer items-center gap-1 pr-3 text-sm outline-none hover:bg-bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${selection.kind === 'location' && selection.id === id ? 'bg-accent-subtle text-accent' : ''}`}
                  style={{ paddingLeft: `${depth * 12}px` }}
                >
                  <button
                    tabIndex={-1}
                    aria-label={`${collapsed.has(id) ? 'Expand' : 'Collapse'} ${state!.storage[id].name}`}
                    disabled={!children}
                    className="w-4 shrink-0 text-fg-muted disabled:invisible"
                    onClick={(event) => {
                      event.stopPropagation();
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      });
                    }}
                  >
                    {collapsed.has(id) ? '▸' : '▾'}
                  </button>
                  <span className="truncate">{state!.storage[id].name}</span>
                </div>
              ))}
              {treeRows.length === 0 ? (
                <p className="px-4 py-2 text-xs leading-5 text-fg-muted">
                  Add a freezer, shelf, box, or plate to organize your stock.
                </p>
              ) : null}
            </div>
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            <div className="space-y-3 px-5 py-4">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-xs text-fg-muted">
                    {selectedLocation
                      ? locationPath(state!, selectedLocation.id)
                      : data.project.name}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">{title}</h2>
                </div>
                {selectedLocation ? (
                  <>
                    <Button
                      disabled={!editable}
                      onClick={() =>
                        setDialog({
                          kind: 'reserve-item',
                          item: { kind: 'storage', id: selectedLocation.id },
                        })
                      }
                    >
                      Reserve location
                    </Button>
                    <Button
                      disabled={!editable || selectedLocation.lifecycle !== 'active'}
                      onClick={() =>
                        setDialog({
                          kind: 'move',
                          item: { kind: 'storage', id: selectedLocation.id },
                        })
                      }
                    >
                      Move location
                    </Button>
                    {selectedLocation.layout.kind === 'fixed-well' ? (
                      <Button
                        variant="danger"
                        disabled={!editable || selectedLocation.lifecycle !== 'active'}
                        onClick={() =>
                          setDialog({
                            kind: 'dispose',
                            item: { kind: 'storage', id: selectedLocation.id },
                          })
                        }
                      >
                        Dispose plate
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
              {selectedLocation ? (
                <>
                  <InventoryCustodyPanel
                    data={data}
                    item={{ kind: 'storage', id: selectedLocation.id }}
                    editable={editable}
                    onDialog={setDialog}
                    onOpenItem={openItem}
                  />
                  <InventoryPhysicalDetails
                    data={data}
                    item={{ kind: 'storage', id: selectedLocation.id }}
                    editable={editable}
                    onDialog={setDialog}
                  />
                  <InventoryStorageConditions
                    key={`${data.project.projectId}:${selectedLocation.id}`}
                    data={data}
                    item={{ kind: 'storage', id: selectedLocation.id }}
                    editable={editable}
                    controller={controller}
                    onDialog={setDialog}
                    onOpenItem={openItem}
                  />
                  <InventoryItemCodes
                    data={data}
                    item={{ kind: 'storage', id: selectedLocation.id }}
                    editable={editable}
                    hasLabelSnapshot={hasLabelSnapshot}
                    onDialog={setDialog}
                  />
                </>
              ) : null}
              {selectedLocation ? (
                <>
                  <div className="flex items-center justify-between text-xs text-fg-muted">
                    <span>
                      {selectedLocation.layout.kind === 'stack'
                        ? 'Stack order · top first'
                        : 'Positions'}
                    </span>
                    <span>
                      {selectedLocation.layout.kind === 'stack'
                        ? `${inventoryStackItems(state!, selectedLocation.id).length} of ${selectedLocation.layout.capacity} occupied`
                        : `${inventoryStoragePositions(selectedLocation).length} positions`}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <div
                      data-testid="inventory-positions"
                      className="grid gap-2"
                      style={{
                        gridTemplateColumns:
                          selectedLocation.layout.kind === 'stack'
                            ? 'minmax(0,1fr)'
                            : selectedLocation.layout.kind === 'named'
                              ? 'repeat(auto-fill,minmax(100px,1fr))'
                              : `repeat(${selectedLocation.layout.columns},minmax(60px,1fr))`,
                      }}
                    >
                      {positions.slice(0, shownPositions).map((position) => {
                        const occupant = inventoryOccupant(state!, selectedLocation.id, position);
                        const physicalLocation =
                          data.availability?.physical.items[selectedLocation.id];
                        const typeRule =
                          physicalLocation?.type?.definition.kind === 'storage'
                            ? physicalLocation.type.definition.positionRules[position]
                            : undefined;
                        const unavailableReason =
                          physicalLocation?.configuration.unavailablePositions[position] ??
                          (typeRule?.kind === 'unavailable' ? typeRule.reason : undefined);
                        const vessel =
                          occupant && Object.hasOwn(state!.vessels, occupant.id)
                            ? state!.vessels[occupant.id]
                            : undefined;
                        const stock = vessel
                          ? Object.values(state!.stocks).find(
                              (stock) => stock.vesselId === vessel.id
                            )
                          : undefined;
                        const occupiedLocation =
                          occupant && Object.hasOwn(state!.storage, occupant.id)
                            ? state!.storage[occupant.id]
                            : undefined;
                        const label =
                          occupiedLocation?.name ??
                          (stock
                            ? (materialNames[stock.materialId] ?? 'Loading material…')
                            : vessel?.kind === 'fixed-well'
                              ? inventoryContentsLabel(contentsByVessel[vessel.id])
                              : (vessel?.name ?? (unavailableReason ? 'Unavailable' : 'Empty')));
                        return (
                          <button
                            key={position}
                            data-location-id={selectedLocation.id}
                            data-position-id={position}
                            data-position-state={unavailableReason ? 'unavailable' : 'available'}
                            title={unavailableReason}
                            aria-label={`Position ${position}, ${label}`}
                            disabled={
                              !occupiedLocation &&
                              !stock &&
                              !vessel &&
                              (!editable || Boolean(unavailableReason))
                            }
                            className={`min-h-16 rounded-md border p-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${stock ? (stock.quality === 'quarantined' ? 'border-warning/40 bg-warning/5' : 'border-accent/30 bg-accent-subtle') : occupiedLocation ? 'border-border bg-bg-subtle' : 'border-dashed border-border hover:bg-bg-subtle'}`}
                            onClick={() => {
                              if (occupiedLocation)
                                choose({ kind: 'location', id: occupiedLocation.id });
                              else if (stock)
                                setDrawer({ kind: 'stock', stockId: stock.id, tab: 'details' });
                              else if (vessel) openItem({ kind: 'vessel', id: vessel.id });
                              else
                                setDialog({
                                  kind: 'receive',
                                  ...(vessel
                                    ? { vesselId: vessel.id }
                                    : {
                                        placement: {
                                          kind: 'located',
                                          storageId: selectedLocation.id,
                                          slotId: position,
                                        },
                                      }),
                                });
                            }}
                          >
                            <span className="block font-semibold">{position}</span>
                            <span className="mt-1 block truncate text-fg-muted">{label}</span>
                            {vessel && !stock && vessel.kind === 'movable' ? (
                              <span className="mt-1 block text-fg-muted">
                                {inventoryContentsLabel(contentsByVessel[vessel.id])}
                              </span>
                            ) : null}
                            {unavailableReason ? (
                              <span className="mt-1 block truncate text-xs text-fg-muted">
                                {unavailableReason}
                              </span>
                            ) : null}
                            {occupant ? (
                              <span className="mt-1 block text-fg-muted">
                                {inventoryCustodyLabel(data.availability?.items[occupant.id])}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {positions.length > shownPositions ? (
                    <Button onClick={() => setShownPositions((value) => value + 200)}>
                      Show more positions
                    </Button>
                  ) : null}
                </>
              ) : null}
              <div className="flex items-center gap-3 pt-2">
                <h3 className="shrink-0 text-sm font-semibold">
                  Stock <span className="font-normal text-fg-muted">({stocks.length})</span>
                </h3>
                <div className="ml-auto w-72">
                  <TextField
                    aria-label="Search stock"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setShown(100);
                    }}
                    placeholder="Search material, container, or location"
                  />
                </div>
              </div>
            </div>
            {stocks.length ? (
              <div className="shrink-0 overflow-x-auto px-5 pb-5">
                <table
                  data-testid="inventory-stock-table"
                  className="w-full border-collapse text-left text-sm"
                >
                  <thead className="border-y border-border bg-bg-subtle text-xs font-medium text-fg-muted">
                    <tr>
                      {['Material', 'Container', 'Quantity', 'Location', 'Condition'].map(
                        (label) => (
                          <th key={label} className="px-3 py-2 font-medium">
                            {label}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visibleStocks.map((stock) => {
                      const vessel = state!.vessels[stock.vesselId];
                      return (
                        <tr
                          key={stock.id}
                          data-stock-id={stock.id}
                          className="cursor-pointer hover:bg-bg-subtle"
                          onClick={() =>
                            setDrawer({ kind: 'stock', stockId: stock.id, tab: 'details' })
                          }
                        >
                          <td className="px-3 py-3">
                            <button
                              className="text-left font-medium text-fg underline-offset-2 hover:underline focus-visible:outline-accent"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDrawer({ kind: 'stock', stockId: stock.id, tab: 'details' });
                              }}
                            >
                              {materialNames[stock.materialId] ?? 'Loading material…'}
                            </button>
                          </td>
                          <td className="px-3 py-3 text-fg-muted">{vessel.name}</td>
                          <td
                            data-testid="inventory-stock-quantity"
                            className="max-w-[12rem] whitespace-normal break-all px-3 py-3 tabular-nums"
                          >
                            {inventoryAmountLabel(stock.quantity)}
                          </td>
                          <td className="max-w-xs px-3 py-3 text-xs text-fg-muted">
                            {vessel.lifecycle === 'disposed'
                              ? 'Disposed'
                              : vesselLocation(state!, vessel, data.availability?.items[vessel.id])}
                          </td>
                          <td
                            className={`px-3 py-3 text-xs ${stock.quality === 'quarantined' ? 'text-warning' : 'text-fg-muted'}`}
                          >
                            {vessel.lifecycle === 'disposed'
                              ? 'Disposed'
                              : stock.quality === 'quarantined'
                                ? 'Quarantined'
                                : 'Usable'}
                            <span className="mt-1 block">
                              {inventoryCustodyLabel(data.availability?.items[vessel.id])}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {stocks.length > shown ? (
                  <div className="mt-3">
                    <Button onClick={() => setShown((value) => value + 100)}>
                      Show more stock
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="px-5 py-8">
                <h3 className="text-sm font-medium">
                  {search ? 'No matching stock' : 'No stock here yet'}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-fg-muted">
                  {search
                    ? 'Try another material, container, or location name.'
                    : unstockedContainers.length
                      ? 'Containers without recorded stock are listed below. Check their contents declaration before receiving or identifying material.'
                      : selection.kind === 'disposed'
                        ? 'Disposed containers remain in history and appear here.'
                        : 'Receive physical stock from a scientific record, then place it in a location.'}
                </p>
                {!search && editable && selection.kind !== 'disposed' ? (
                  <div className="mt-4">
                    <Button variant="primary" onClick={() => setDialog({ kind: 'receive' })}>
                      Receive stock
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
            {unstockedContainers.length ? (
              <section data-testid="inventory-empty-containers" className="space-y-3 px-5 pb-5">
                <h3 className="text-sm font-semibold">Containers without recorded stock</h3>
                <div className="divide-y divide-border rounded border border-border">
                  {unstockedContainers.slice(0, shown).map((vessel) => (
                    <button
                      key={vessel.id}
                      data-vessel-id={vessel.id}
                      className="flex w-full flex-wrap justify-between gap-2 px-3 py-3 text-left text-sm hover:bg-bg-subtle"
                      onClick={() => openItem({ kind: 'vessel', id: vessel.id })}
                    >
                      <span className="font-medium">
                        {vessel.name} · {inventoryContentsLabel(contentsByVessel[vessel.id])}
                      </span>
                      <span className="text-xs text-fg-muted">
                        {vesselLocation(state!, vessel, data.availability?.items[vessel.id])} ·{' '}
                        {inventoryCustodyLabel(data.availability?.items[vessel.id])}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
          {drawer.kind !== 'closed' ? (
            <aside
              className="absolute inset-y-0 right-0 z-10 flex w-80 max-w-full flex-col overflow-y-auto border-l border-border bg-bg shadow-lg xl:static xl:shrink-0 xl:shadow-none"
              data-testid="inventory-detail-drawer"
            >
              <div className="flex items-start justify-between gap-2 border-b border-border p-4">
                <div className="min-w-0">
                  <h2 className="break-words text-sm font-semibold">
                    {selectedStock
                      ? (materialNames[selectedStock.materialId] ?? 'Stock details')
                      : selectedItem
                        ? selectedItem.name
                        : drawer.kind === 'reservations'
                          ? 'Reservations'
                          : 'Inventory history'}
                  </h2>
                  {selectedVessel ? (
                    <p className="mt-1 text-xs text-fg-muted">{selectedVessel.name}</p>
                  ) : null}
                </div>
                <Button
                  variant="icon"
                  aria-label="Close stock details"
                  onClick={() => setDrawer({ kind: 'closed' })}
                >
                  ×
                </Button>
              </div>
              {drawer.kind === 'stock' && selectedStock && selectedVessel ? (
                <>
                  <div className="border-b border-border p-4">
                    <InventoryContentsPanel
                      data={data}
                      vesselId={selectedVessel.id}
                      editable={editable}
                      onDialog={setDialog}
                    />
                  </div>
                  <div
                    role="tablist"
                    aria-label="Stock information"
                    className="flex gap-2 border-b border-border p-3"
                  >
                    {(['details', 'history', 'reservations'] as const).map((tab) => (
                      <button
                        key={tab}
                        role="tab"
                        aria-selected={drawer.tab === tab}
                        onClick={() => setDrawer({ ...drawer, tab })}
                        className={`rounded px-3 py-1.5 text-xs capitalize ${drawer.tab === tab ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-bg-subtle'}`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  {drawer.tab === 'history' ? (
                    renderHistory(history)
                  ) : drawer.tab === 'reservations' ? (
                    <InventoryReservationList
                      data={data}
                      editable={editable}
                      stockId={selectedStock.id}
                      reservationIds={
                        data.availability?.stocks[selectedStock.id]?.reservationIds ?? []
                      }
                      onDialog={setDialog}
                      onRefresh={() => void controller.refresh()}
                    />
                  ) : (
                    <div className="space-y-5 p-4">
                      <InventoryCustodyPanel
                        data={data}
                        item={{ kind: 'vessel', id: selectedVessel.id }}
                        editable={editable}
                        onDialog={setDialog}
                        onOpenItem={openItem}
                      />
                      <InventoryStockAvailability data={data} stockId={selectedStock.id} />
                      <InventoryValidityPanel
                        data={data}
                        stockId={selectedStock.id}
                        editable={editable}
                        controller={controller}
                        onDialog={setDialog}
                      />
                      <InventoryStockLotControls
                        data={data}
                        stockId={selectedStock.id}
                        onInspect={(lotId) => setDialog({ kind: 'lot-controls', lotId })}
                      />
                      <InventoryPhysicalDetails
                        data={data}
                        item={{ kind: 'vessel', id: selectedVessel.id }}
                        editable={editable}
                        onDialog={setDialog}
                      />
                      <InventoryStorageConditions
                        key={`${data.project.projectId}:${selectedStock.id}`}
                        data={data}
                        item={{ kind: 'vessel', id: selectedVessel.id }}
                        stockId={selectedStock.id}
                        editable={editable}
                        controller={controller}
                        onDialog={setDialog}
                        onOpenItem={openItem}
                      />
                      <InventoryItemCodes
                        data={data}
                        item={{ kind: 'vessel', id: selectedVessel.id }}
                        editable={editable}
                        hasLabelSnapshot={hasLabelSnapshot}
                        onDialog={setDialog}
                      />
                      <dl className="space-y-3 text-sm">
                        <div>
                          <dt className="text-xs text-fg-muted">Lot or preparation</dt>
                          <dd className="mt-1">
                            {selectedStock.source.kind === 'lot'
                              ? state!.lots[selectedStock.source.lotId].name
                              : 'Unattributed'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-fg-muted">Composition</dt>
                          <dd className="mt-2" data-testid="inventory-stock-composition">
                            {compositionValues(selectedStock.composition, materialNames)}
                          </dd>
                        </div>
                        {selectedLot && selectedInputs.length ? (
                          <div>
                            <dt className="text-xs text-fg-muted">Lot contributions</dt>
                            <dd className="mt-2" data-testid="inventory-lot-contributions">
                              {renderContributions(selectedLot)}
                            </dd>
                          </div>
                        ) : null}
                        <div>
                          <dt className="text-xs text-fg-muted">Container limits</dt>
                          <dd className="mt-1">
                            Capacity{' '}
                            {selectedVessel.limits.capacity.kind === 'known'
                              ? `${selectedVessel.limits.capacity.value} µL`
                              : 'unknown'}{' '}
                            · Dead volume{' '}
                            {selectedVessel.limits.deadVolume.kind === 'known'
                              ? `${selectedVessel.limits.deadVolume.value} µL`
                              : 'unknown'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-fg-muted">Condition</dt>
                          <dd className="mt-1">
                            {selectedVessel.lifecycle === 'disposed'
                              ? 'Disposed'
                              : selectedStock.quality === 'quarantined'
                                ? 'Quarantined'
                                : 'Usable'}
                          </dd>
                        </div>
                      </dl>
                      {selectedVessel.lifecycle === 'active' ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              disabled={!editable || reserveBlocked}
                              onClick={() =>
                                setDialog({ kind: 'reserve-quantity', stockId: selectedStock.id })
                              }
                            >
                              Reserve quantity
                            </Button>
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({
                                  kind: 'reserve-item',
                                  item: { kind: 'vessel', id: selectedVessel.id },
                                })
                              }
                            >
                              Reserve item
                            </Button>
                            <Button
                              disabled={!editable || withdrawBlocked}
                              onClick={() =>
                                setDialog({
                                  kind: 'fulfill-reservation',
                                  stockId: selectedStock.id,
                                })
                              }
                            >
                              Use reserved stock
                            </Button>
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({ kind: 'composition', stockId: selectedStock.id })
                              }
                            >
                              Record composition
                            </Button>
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({ kind: 'attribute', stockId: selectedStock.id })
                              }
                            >
                              Assign lot
                            </Button>
                            <Button
                              disabled={!editable || withdrawBlocked}
                              onClick={() =>
                                setDialog({ kind: 'transfer', stockId: selectedStock.id })
                              }
                            >
                              Transfer or aliquot
                            </Button>
                            <Button
                              disabled={
                                !editable ||
                                withdrawBlocked ||
                                selectedStock.quantity.kind === 'unknown' ||
                                inventoryAmountUnitDefinition(selectedStock.quantity.unit)
                                  .dimension !== 'volume'
                              }
                              onClick={() => setDialog({ kind: 'pool', stockId: selectedStock.id })}
                            >
                              Pool stocks
                            </Button>
                            <Button
                              disabled={
                                !editable ||
                                withdrawBlocked ||
                                selectedStock.quantity.kind === 'unknown' ||
                                inventoryAmountUnitDefinition(selectedStock.quantity.unit)
                                  .dimension !== 'volume'
                              }
                              onClick={() =>
                                setDialog({ kind: 'dilute', stockId: selectedStock.id })
                              }
                            >
                              Dilute stock
                            </Button>
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({ kind: 'limits', vesselId: selectedVessel.id })
                              }
                            >
                              Container limits
                            </Button>
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({ kind: 'lot', sourceStockId: selectedStock.id })
                              }
                            >
                              Record preparation
                            </Button>
                            <Button
                              variant="primary"
                              disabled={
                                !editable ||
                                withdrawBlocked ||
                                selectedStock.quality === 'quarantined' ||
                                selectedStock.quantity.kind === 'unknown' ||
                                selectedStock.quantity.value === '0'
                              }
                              onClick={() => setDialog({ kind: 'use', stockId: selectedStock.id })}
                            >
                              Use stock
                            </Button>
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({ kind: 'reconcile', stockId: selectedStock.id })
                              }
                            >
                              Record quantity
                            </Button>
                            {selectedVessel.kind === 'movable' ? (
                              <Button
                                disabled={!editable}
                                onClick={() =>
                                  setDialog({
                                    kind: 'move',
                                    item: { kind: 'vessel', id: selectedVessel.id },
                                  })
                                }
                              >
                                Move
                              </Button>
                            ) : null}
                            <Button
                              disabled={!editable}
                              onClick={() =>
                                setDialog({
                                  kind: 'quality',
                                  stockId: selectedStock.id,
                                  quality:
                                    selectedStock.quality === 'quarantined'
                                      ? 'usable'
                                      : 'quarantined',
                                })
                              }
                            >
                              {selectedStock.quality === 'quarantined'
                                ? 'Release stock'
                                : 'Quarantine stock'}
                            </Button>
                            {selectedVessel.kind === 'movable' ? (
                              <Button
                                variant="danger"
                                disabled={!editable}
                                onClick={() =>
                                  setDialog({
                                    kind: 'dispose',
                                    item: { kind: 'vessel', id: selectedVessel.id },
                                  })
                                }
                              >
                                Dispose container
                              </Button>
                            ) : null}
                          </div>
                          {selectedStock.quantity.kind === 'unknown' ? (
                            <Notice>Record a measured quantity before using this stock.</Notice>
                          ) : selectedStock.quality === 'quarantined' ? (
                            <Notice tone="warning">
                              Release this stock from quarantine before use.
                            </Notice>
                          ) : null}
                          {selectedVessel.kind === 'fixed-well' ? (
                            <p className="text-xs leading-5 text-fg-muted">
                              This well moves with its plate. Select the plate to move or dispose
                              it.
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <Notice>Disposed stock remains available for historical reference.</Notice>
                      )}
                    </div>
                  )}
                </>
              ) : drawer.kind === 'item' && selectedItem ? (
                <div
                  className="space-y-4 p-4"
                  data-testid="inventory-item-details"
                  data-item-id={drawer.item.id}
                >
                  <InventoryCustodyPanel
                    data={data}
                    item={drawer.item}
                    editable={editable}
                    onDialog={setDialog}
                    onOpenItem={openItem}
                  />
                  {drawer.item.kind === 'vessel' ? (
                    <InventoryContentsPanel
                      data={data}
                      vesselId={drawer.item.id}
                      editable={editable}
                      onDialog={setDialog}
                    />
                  ) : null}
                  <InventoryPhysicalDetails
                    data={data}
                    item={drawer.item}
                    editable={editable}
                    onDialog={setDialog}
                  />
                  <InventoryStorageConditions
                    key={`${data.project.projectId}:${drawer.item.id}`}
                    data={data}
                    item={drawer.item}
                    editable={editable}
                    controller={controller}
                    onDialog={setDialog}
                    onOpenItem={openItem}
                  />
                  <InventoryItemCodes
                    data={data}
                    item={drawer.item}
                    editable={editable}
                    hasLabelSnapshot={hasLabelSnapshot}
                    onDialog={setDialog}
                  />
                  {drawer.item.kind === 'vessel' && selectedItem.lifecycle === 'active' ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={
                          !editable || contentsByVessel[drawer.item.id]?.kind !== 'declared-empty'
                        }
                        onClick={() => setDialog({ kind: 'receive', vesselId: drawer.item.id })}
                      >
                        Receive stock
                      </Button>
                      {data.state.vessels[drawer.item.id]?.kind === 'movable' ? (
                        <>
                          <Button
                            disabled={!editable}
                            onClick={() => setDialog({ kind: 'reserve-item', item: drawer.item })}
                          >
                            Reserve item
                          </Button>
                          <Button
                            disabled={
                              !editable ||
                              ('kind' in selectedItem && selectedItem.kind === 'fixed-well')
                            }
                            onClick={() => setDialog({ kind: 'move', item: drawer.item })}
                          >
                            Move
                          </Button>
                          <Button
                            disabled={!editable}
                            onClick={() => setDialog({ kind: 'dispose', item: drawer.item })}
                          >
                            Dispose container
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs text-fg-muted">
                          This well moves with its plate and cannot be disposed independently.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : drawer.kind === 'reservations' ? (
                <InventoryReservationList
                  data={data}
                  editable={editable}
                  onDialog={setDialog}
                  onRefresh={() => void controller.refresh()}
                />
              ) : (
                renderHistory(data.history)
              )}
            </aside>
          ) : null}
        </div>
      )}
      {productionProject ? (
        <InventorySavedProductions
          key={`${productionProject.projectId}:${productionProject.defaultInventoryId}`}
          scope={{
            project: productionProject.projectId,
            inventoryId: productionProject.defaultInventoryId,
          }}
          onClose={() => setProductionProject(null)}
        />
      ) : null}
      {valueAssociationProject ? (
        <InventorySavedValueAssociations
          key={`${valueAssociationProject.projectId}:${valueAssociationProject.defaultInventoryId}`}
          scope={{
            project: valueAssociationProject.projectId,
            inventoryId: valueAssociationProject.defaultInventoryId,
          }}
          onClose={() => setValueAssociationProject(null)}
        />
      ) : null}
      {platePlanProject ? (
        <InventoryPlatePlans
          key={`${platePlanProject.projectId}:${platePlanProject.defaultInventoryId}`}
          project={platePlanProject}
          data={data ?? undefined}
          controller={controller}
          onClose={() => setPlatePlanProject(null)}
        />
      ) : null}
      {dialog.kind !== 'none' && data ? (
        dialog.kind === 'export-archive' ? (
          <InventoryArchiveExportForm
            key={`${data.project.projectId}:export-archive`}
            data={data}
            controller={controller}
            status={status}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'import-archive' ? (
          <InventoryArchiveImportForm
            key={`${data.project.projectId}:import-archive`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'scientific-transfer' ? (
          <InventoryScientificForm
            key={data.project.projectId + ':' + data.project.defaultInventoryId}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'stockroom' ? (
          <InventoryStockroomForm
            key={data.project.projectId + ':' + data.project.defaultInventoryId}
            data={data}
            status={status}
            controller={controller}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'receive-delivery' ? (
          <InventoryArrivalForm
            key={data.project.projectId + ':' + data.project.defaultInventoryId}
            data={data}
            status={status}
            controller={controller}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'receive-table' ? (
          <InventoryTableForm
            key={`${data.project.projectId}:receive-table`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'stocktake' ? (
          <InventoryStocktakeForm
            key={`${data.project.projectId}:stocktake`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'source-revision' ? (
          <InventorySourceRevisionForm
            key={`${data.project.projectId}:source-revision`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'import-hierarchy' ? (
          <InventoryHierarchyForm
            key={`${data.project.projectId}:import-hierarchy`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'receive-mapped-table' ? (
          <InventoryMappedTableForm
            key={`${data.project.projectId}:receive-mapped-table`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'inspect-benchling-capture' ? (
          <InventoryBenchlingCaptureForm
            key={`${data.project.projectId}:${data.project.defaultInventoryId}:inspect-benchling-capture`}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : isInventoryTemperatureDialog(dialog) ? (
          <InventoryTemperatureForm
            key={`${data.project.projectId}:${dialog.kind}:${'item' in dialog ? dialog.item.id : 'target' in dialog ? `${dialog.target.kind}:${dialog.target.id}` : dialog.claimId}:${'assertion' in dialog ? dialog.assertion : ''}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'item-label' ? (
          <InventoryLabelForm
            key={`${data.project.projectId}:${data.project.defaultInventoryId}:${dialog.codeId}`}
            codeId={dialog.codeId}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : isInventoryItemCodeDialog(dialog) ? (
          <InventoryItemCodeForm
            key={`${data.project.projectId}:${dialog.kind}:${'item' in dialog ? dialog.item.id : 'expected' in dialog ? dialog.expected?.id : 'codeId' in dialog ? dialog.codeId : ''}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            lookup={itemCodeLookup}
            materialNames={materialNames}
            onClose={() => setDialog({ kind: 'none' })}
            onInspect={(item) => {
              setDialog({ kind: 'none' });
              openItem(item);
            }}
          />
        ) : isInventoryPhysicalDialog(dialog) ? (
          <InventoryPhysicalWorkspace
            key={data.project.projectId}
            dialog={dialog}
            data={data}
            controller={controller}
            status={status}
            catalog={catalog}
            onDialog={setDialog}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'contents' ? (
          <InventoryContentsForm
            key={`${data.project.projectId}:${data.project.defaultInventoryId}:${dialog.vesselId}:${dialog.action}`}
            dialog={dialog}
            data={data}
            controller={controller}
            status={status}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'custody' ? (
          <InventoryCustodyForm
            key={`${data.project.projectId}:${dialog.item.id}:${dialog.action}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'opening' ? (
          <InventoryOpeningForm
            key={`${data.project.projectId}:${dialog.stockId}:${dialog.supersedesId ?? ''}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'validity' ? (
          <InventoryValidityForm
            key={`${data.project.projectId}:${dialog.headId ?? JSON.stringify(dialog.owner)}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'lot-controls' ? (
          <InventoryLotControlsForm
            key={`${data.project.projectId}:${dialog.lotId ?? ''}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : isInventoryReservationDialog(dialog) ? (
          <InventoryReservationForm
            key={`${data.project.projectId}:${dialog.kind}:${'stockId' in dialog ? dialog.stockId : 'reservationId' in dialog ? dialog.reservationId : dialog.item.id}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : dialog.kind === 'composition' ? (
          <InventoryCompositionForm
            key={`${data.project.projectId}:${dialog.stockId}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            client={platform().inventory}
            materialNames={materialNames}
            onMaterial={(id, name) => setMaterialNames((current) => ({ ...current, [id]: name }))}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : isInventoryMaterialDialog(dialog) ? (
          <InventoryMaterialForm
            key={`${data.project.projectId}:${dialog.kind}:${'stockId' in dialog ? dialog.stockId : ''}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
          />
        ) : (
          <InventoryForm
            key={`${data.project.projectId}:${dialog.kind}:${'stockId' in dialog ? dialog.stockId : 'item' in dialog ? dialog.item.id : ''}`}
            dialog={dialog}
            data={data}
            status={status}
            controller={controller}
            client={platform().inventory}
            onClose={() => setDialog({ kind: 'none' })}
            onMaterial={(id, name) => setMaterialNames((current) => ({ ...current, [id]: name }))}
          />
        )
      ) : null}
    </section>
  );
}
