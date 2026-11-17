import { applyInventoryCommandBatch } from './inventory-state';
import { parseInventoryExecutionContext, parseInventoryState } from './inventory-validation';
import {
  createInventoryState,
  MAX_INVENTORY_BATCH_COMMANDS,
  type InventoryCommand,
  type InventoryExecutionContext,
  type InventoryState,
  type InventoryTransition,
} from './inventory-types';
import { normalizeInventoryQuantity } from './inventory-quantity';
import {
  normalizeInventoryAmount,
  compareInventoryAmounts,
  type InventoryAmountUnit,
} from './inventory-amount';
import {
  inventoryTableCanonicalJson as canonical,
  inventoryTableSha256,
} from './inventory-table-binding';
import type { InventoryTableResolvedMaterial } from './inventory-table-types';
import type {
  InventoryArrival,
  InventoryArrivalApplication,
  InventoryArrivalChoices,
  InventoryArrivalComponentChoice,
  InventoryArrivalPreview,
  InventoryArrivalPreviewInput,
  InventoryArrivalResolvedTarget,
  InventoryResolvedArrivalOptions,
} from './inventory-arrival-types';
import {
  arrivalFail,
  inventoryArrivalDocumentMetadata,
  inventoryArrivalId,
  inventoryArrivalPhysicalIds,
  inventoryArrivalRecordedClaims,
  InventoryArrivalInputError,
  parseInventoryArrivalChoices,
  parseInventoryArrivalSource,
} from './inventory-arrival-source';

export * from './inventory-arrival-source';
const order = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const normalizedChoices = (options: InventoryArrivalChoices): InventoryArrivalChoices => ({
  components: options.components
    .map((choice) =>
      choice.kind === 'identified'
        ? { ...choice, quantity: normalizeInventoryQuantity(choice.quantity) }
        : choice
    )
    .sort((a, b) => order(a.componentKey, b.componentKey)),
});

export function inventoryArrivalPreview(
  state: InventoryState | null,
  input: InventoryArrivalPreviewInput
): InventoryArrivalPreview {
  let sourceSha256: InventoryArrival['sourceSha256'] | null = null,
    arrivalId: string | null = null;
  const facts = () => ({
    schema: 'dnaforge.inventory-arrival-preview.v1' as const,
    target: { ...input.target },
    sourceSha256,
    arrivalId,
  });
  try {
    const previous = state === null ? createInventoryState() : parseInventoryState(state);
    const context = parseInventoryExecutionContext({
      at: input.asOf,
      principal: input.principal,
      authority: input.authority,
    });
    if (
      input.target.present !== (state !== null) ||
      input.target.revision !== previous.revision ||
      !input.target.projectId?.trim() ||
      !input.target.inventoryId?.trim()
    )
      arrivalFail(
        'ARRIVAL_TARGET_CHANGED',
        '/target',
        'The original project, inventory presence and revision must match current inventory.'
      );
    if (context.at < previous.lastRecordedAt)
      arrivalFail('CLOCK_REGRESSION', '/asOf', 'The trusted clock precedes recorded inventory.');
    const source = parseInventoryArrivalSource(input.sourceText, input.maxBytes);
    sourceSha256 = inventoryTableSha256(input.sourceText);
    arrivalId = inventoryArrivalId(source.identity);
    if (source.observedAt !== null && source.observedAt > context.at)
      arrivalFail(
        'OBSERVATION_TIME_FUTURE',
        '/observedAt',
        'The observed arrival cannot follow its native recording time.'
      );
    const choices = normalizedChoices(parseInventoryArrivalChoices(input.options));
    if (
      choices.components.length !== source.components.length ||
      choices.components.some(
        (choice) => !source.components.some((item) => item.key === choice.componentKey)
      )
    )
      arrivalFail(
        'ARRIVAL_CHOICES_INCOMPLETE',
        '/options/components',
        'Every listed component needs exactly one explicit disposition.'
      );
    const existing = previous.arrivals[arrivalId];
    if (existing) {
      const retained = {
        components: existing.components
          .map((item) => item.choice)
          .sort((a, b) => order(a.componentKey, b.componentKey)),
      };
      if (existing.sourceSha256 !== sourceSha256 || canonical(retained) !== canonical(choices))
        arrivalFail(
          'ARRIVAL_NEEDS_RECONCILIATION',
          '/identity',
          'This delivery is already recorded with different original source or admission choices. Compare it explicitly; it cannot receive again.'
        );
      const materials = input.bindings
        .flatMap((binding) =>
          binding.kind === 'admitted'
            ? [
                {
                  key: binding.key,
                  materialId: binding.materialId,
                  fingerprint: binding.fingerprint,
                },
              ]
            : []
        )
        .sort((a, b) => order(a.key, b.key));
      return {
        ...facts(),
        kind: 'no-change',
        issues: [],
        options: {
          ...choices,
          materials,
          targets: existing.components
            .map((item) => structuredClone(item.target))
            .sort((a, b) => order(a.componentKey, b.componentKey)),
        },
        planDigest: null,
        commands: [],
        arrival: structuredClone(existing),
      };
    }
    const materialChoices = choices.components.filter(
      (choice): choice is Extract<InventoryArrivalComponentChoice, { kind: 'identified' }> =>
        choice.kind === 'identified'
    );
    const bindings = new Map<string, InventoryTableResolvedMaterial>();
    if (input.bindings.length !== materialChoices.length)
      arrivalFail(
        'ARRIVAL_MATERIALS_INCOMPLETE',
        '/bindings',
        'Current scientific admission must cover every identified component exactly.'
      );
    for (const binding of input.bindings) {
      const choice = materialChoices.find((item) => item.componentKey === binding.key);
      if (
        !choice ||
        bindings.has(binding.key) ||
        binding.materialId !== choice.materialId ||
        binding.kind !== 'admitted' ||
        !/^sha256:[a-f0-9]{64}$/u.test(binding.fingerprint)
      )
        arrivalFail(
          'ARRIVAL_MATERIAL_UNAVAILABLE',
          '/bindings',
          'Every selected scientific material must have one current admitted fingerprint.'
        );
      bindings.set(binding.key, {
        key: binding.key,
        materialId: binding.materialId,
        fingerprint: binding.fingerprint,
      });
    }
    const commands: InventoryCommand[] = [],
      targets: InventoryArrivalResolvedTarget[] = [],
      newLots = new Map<
        string,
        {
          materialId: string;
          lot: Extract<InventoryArrivalComponentChoice, { kind: 'identified' }>['lot'];
          id: string;
        }
      >();
    const claims = new Map(source.claims.map((claim) => [claim.key, claim]));
    for (const choice of choices.components) {
      const target: InventoryArrivalResolvedTarget = {
        componentKey: choice.componentKey,
        lotId: null,
        stockId: null,
        vesselId: null,
      };
      if (choice.kind === 'identified') {
        const quantity = normalizeInventoryQuantity(choice.quantity);
        if (choice.quantityBasis.kind === 'supplier-declared') {
          const claim = claims.get(choice.quantityBasis.claimKey);
          if (
            !claim ||
            claim.subject.kind !== 'component' ||
            claim.subject.componentKey !== choice.componentKey ||
            claim.claim.kind !== 'quantity' ||
            quantity.kind !== 'known'
          )
            arrivalFail(
              'ARRIVAL_QUANTITY_CLAIM_INVALID',
              '/options/components/quantityBasis',
              'A supplier-declared amount requires this component’s explicit retained quantity claim.'
            );
          let declared;
          try {
            declared = normalizeInventoryAmount({
              value: claim.claim.valueLexeme,
              unit: claim.claim.unitText as InventoryAmountUnit,
            });
          } catch {
            arrivalFail(
              'ARRIVAL_QUANTITY_CLAIM_UNSUPPORTED',
              '/options/components/quantityBasis',
              'Unsupported supplier units remain evidence; select an unknown supported balance basis or record an actual measurement.'
            );
          }
          const compared = compareInventoryAmounts(quantity, declared);
          if (compared.kind !== 'compared' || compared.order !== 0)
            arrivalFail(
              'ARRIVAL_QUANTITY_CLAIM_MISMATCH',
              '/options/components/quantity',
              'The admitted supplier amount must exactly equal its selected source claim in the same dimension.'
            );
        }
        let lotId: string | null = null;
        if (choice.lot.kind === 'existing') {
          const lot = previous.lots[choice.lot.lotId];
          if (!lot || lot.materialId !== choice.materialId)
            arrivalFail(
              'ARRIVAL_LOT_MATERIAL_MISMATCH',
              '/options/components/lot',
              'The explicitly selected existing lot must have the same scientific material.'
            );
          lotId = lot.id;
        } else if (choice.lot.kind === 'new') {
          const sourceComponent = source.components.find(
            (item) => item.key === choice.componentKey
          )!;
          if (
            source.supplier === null ||
            sourceComponent.componentBatch === null ||
            choice.lot.supplier !== source.supplier ||
            choice.lot.lotNumber !== sourceComponent.componentBatch
          )
            arrivalFail(
              'ARRIVAL_SUPPLIER_LOT_MISMATCH',
              '/options/components/lot',
              'A new received lot requires the exact recorded supplier and component batch; use explicit unattributed stock when those facts are unknown.'
            );
          const planned = newLots.get(choice.lot.lotKey);
          lotId =
            planned?.id ??
            inventoryArrivalPhysicalIds(input.target, source.identity, 'lot', choice.lot.lotKey);
          if (
            planned &&
            (planned.materialId !== choice.materialId ||
              canonical(planned.lot) !== canonical(choice.lot))
          )
            arrivalFail(
              'ARRIVAL_LOT_CHOICE_CONFLICT',
              '/options/components/lot',
              'A shared new lot key must have identical material and received-lot choices.'
            );
          if (!planned) {
            newLots.set(choice.lot.lotKey, {
              materialId: choice.materialId,
              lot: choice.lot,
              id: lotId,
            });
            commands.push(
              {
                kind: 'create-lot',
                id: lotId,
                materialId: choice.materialId,
                name: choice.lot.name,
                origin: {
                  kind: 'received',
                  supplier: choice.lot.supplier,
                  lotNumber: choice.lot.lotNumber,
                },
              },
              { kind: 'manage-lot', lotId, reason: choice.lot.managementReason }
            );
          }
        }
        const vesselId = inventoryArrivalPhysicalIds(
            input.target,
            source.identity,
            'vessel',
            choice.componentKey
          ),
          stockId = inventoryArrivalPhysicalIds(
            input.target,
            source.identity,
            'stock',
            choice.componentKey
          );
        commands.push({
          kind: 'create-vessel',
          id: vesselId,
          name: choice.vessel.name,
          placement: choice.vessel.placement,
        });
        if (lotId === null)
          commands.push({
            kind: 'receive-stock',
            id: stockId,
            vesselId,
            materialId: choice.materialId,
            quantity,
            quality: choice.stockQuality.value,
          });
        else
          commands.push({
            kind: 'receive-lot-stock',
            id: stockId,
            vesselId,
            lotId,
            quantity,
            quality: choice.stockQuality.value,
          });
        targets.push({ ...target, lotId, vesselId, stockId });
      } else if (choice.kind === 'unidentified-physical' || choice.kind === 'unobserved-physical') {
        const vesselId = inventoryArrivalPhysicalIds(
          input.target,
          source.identity,
          'vessel',
          choice.componentKey
        );
        commands.push(
          {
            kind: 'create-vessel',
            id: vesselId,
            name: choice.vessel.name,
            placement: choice.vessel.placement,
          },
          {
            kind: 'record-vessel-contents',
            vesselId,
            knowledge: choice.kind === 'unidentified-physical' ? 'unidentified' : 'unobserved',
            reason: choice.reason,
          }
        );
        targets.push({ ...target, vesselId });
      } else targets.push(target);
    }
    if (commands.length > MAX_INVENTORY_BATCH_COMMANDS)
      arrivalFail(
        'ARRIVAL_BATCH_TOO_LARGE',
        '/commands',
        `The complete receiving plan exceeds ${MAX_INVENTORY_BATCH_COMMANDS} existing commands and cannot be split silently.`
      );
    if (previous.revision >= Number.MAX_SAFE_INTEGER)
      arrivalFail('REVISION_EXHAUSTED', '/target', 'The inventory revision cannot advance safely.');
    const transition = commands.length
      ? applyInventoryCommandBatch(
          previous,
          { expectedRevision: previous.revision, commands },
          context
        )
      : {
          ok: true as const,
          state: { ...previous, revision: previous.revision + 1, lastRecordedAt: context.at },
        };
    if (!transition.ok) arrivalFail(transition.code, '/commands', transition.message);
    const materials = [...bindings.values()].sort((a, b) => order(a.key, b.key));
    const options: InventoryResolvedArrivalOptions = { ...choices, materials, targets };
    const arrival: InventoryArrival = {
      id: arrivalId,
      identity: structuredClone(source.identity),
      sourceSha256,
      admissionSha256: inventoryTableSha256(
        canonical({
          format: 'dnaforge.inventory-arrival-admission.v1',
          identity: source.identity,
          scope: source.scope,
          packages: source.packages,
          components: source.components,
          choices,
        })
      ),
      supplier: source.supplier,
      observedAt: source.observedAt,
      observationReason: source.observationReason,
      scope: structuredClone(source.scope),
      documents: source.documents.map(inventoryArrivalDocumentMetadata),
      packages: structuredClone(source.packages),
      claims: inventoryArrivalRecordedClaims(source),
      components: source.components.map((item) => {
        const choice = choices.components.find((value) => value.componentKey === item.key)!;
        return {
          ...structuredClone(item),
          choice: structuredClone(choice),
          target: structuredClone(targets.find((value) => value.componentKey === item.key)!),
          receivedQuantity:
            choice.kind === 'identified' ? normalizeInventoryQuantity(choice.quantity) : null,
        };
      }),
      at: context.at,
      by: { ...context.principal },
    };
    parseInventoryState({
      ...transition.state,
      arrivals: { ...previous.arrivals, [arrivalId]: arrival },
    });
    const planDigest = inventoryTableSha256(
      canonical({
        format: 'dnaforge.inventory-arrival-plan.v1',
        sourceSha256,
        target: input.target,
        options,
        commands,
        arrival: { ...arrival, at: null, by: null },
      })
    );
    return { ...facts(), kind: 'ready', issues: [], options, planDigest, commands, arrival };
  } catch (error) {
    return {
      ...facts(),
      kind: 'blocked',
      issues: [
        error instanceof InventoryArrivalInputError
          ? { code: error.code, pointer: error.pointer, message: error.message }
          : {
              code: 'ARRIVAL_INPUT_INVALID',
              pointer: '/sourceText',
              message:
                error instanceof Error
                  ? error.message
                  : 'The arrival source or choices are invalid.',
            },
      ],
      options: null,
      planDigest: null,
      commands: [],
      arrival: null,
    };
  }
}

export function applyInventoryArrival(
  state: InventoryState | null,
  application: InventoryArrivalApplication,
  context: InventoryExecutionContext,
  maxBytes: number
): InventoryTransition {
  const preview = inventoryArrivalPreview(state, {
    ...application,
    options: { components: application.options.components },
    bindings: application.options.materials.map((material) => ({
      ...material,
      kind: 'admitted' as const,
    })),
    asOf: context.at,
    principal: context.principal,
    authority: context.authority,
    maxBytes,
  });
  if (
    preview.kind !== 'ready' ||
    preview.planDigest !== application.expectedPlanDigest ||
    canonical(preview.options) !== canonical(application.options)
  )
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      message:
        preview.kind === 'blocked'
          ? (preview.issues[0]?.message ?? 'The arrival is blocked.')
          : 'The delivery is already recorded or its source, admission choices or target changed. Preview it again.',
    };
  const previous = state === null ? createInventoryState() : parseInventoryState(state);
  const transition = preview.commands.length
    ? applyInventoryCommandBatch(
        previous,
        { expectedRevision: previous.revision, commands: preview.commands },
        context
      )
    : {
        ok: true as const,
        state: { ...previous, revision: previous.revision + 1, lastRecordedAt: context.at },
      };
  if (!transition.ok) return transition;
  return {
    ok: true,
    state: parseInventoryState({
      ...transition.state,
      arrivals: { ...previous.arrivals, [preview.arrival.id]: preview.arrival },
    }),
  };
}
