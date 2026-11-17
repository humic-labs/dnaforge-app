import type { InventoryState } from './inventory-types';
import { normalizeInventoryAmount } from './inventory-amount';
import { inventoryArrivalId } from './inventory-arrival-source';
import { inventoryTableCanonicalJson } from './inventory-table-binding';

function invalid(message: string): never {
  throw new TypeError(message);
}

export function validateInventoryArrivalState(state: InventoryState): void {
  const vesselIds = new Set<string>();
  const stockIds = new Set<string>();
  for (const [id, arrival] of Object.entries(state.arrivals)) {
    if (arrival.id !== id || inventoryArrivalId(arrival.identity) !== id)
      invalid('An arrival key must retain its exact versioned delivery identity.');
    if (
      arrival.at > state.lastRecordedAt ||
      (arrival.observedAt !== null && arrival.observedAt > arrival.at)
    )
      invalid('Arrival observations must be inside their recorded native lifetime.');
    for (const records of [arrival.documents, arrival.packages, arrival.components, arrival.claims])
      if (new Set(records.map((row) => row.key)).size !== records.length)
        invalid('Arrival source keys must be distinct within each collection.');
    const documents = new Map(arrival.documents.map((document) => [document.key, document]));
    const packages = new Set(arrival.packages.map((row) => row.key));
    const components = new Set(arrival.components.map((row) => row.key));
    const claims = new Map(arrival.claims.map((claim) => [claim.key, claim]));
    for (const claim of arrival.claims) {
      const document = documents.get(claim.selection.documentKey);
      if (!document || document.sha256 !== claim.selection.expectedSha256)
        invalid('Supplier claims must pin an exact retained document hash.');
      if (
        (claim.subject.kind === 'package' && !packages.has(claim.subject.packageKey)) ||
        (claim.subject.kind === 'component' && !components.has(claim.subject.componentKey))
      )
        invalid('Supplier claim subjects must exist in their original arrival.');
      const locator = claim.selection.locator;
      if (
        locator.kind === 'utf8-byte-range' &&
        (locator.endByte <= locator.startByte || locator.endByte > document.byteLength)
      )
        invalid('Supplier text selections must fit their original document byte range.');
      if (locator.kind === 'pdf-region') {
        if (
          document.mediaType !== 'application/pdf' ||
          claim.verification !== 'operator-cited-pdf-region'
        )
          invalid('PDF quotes remain explicit operator citations of PDF documents.');
      } else if (
        document.mediaType === 'application/pdf' ||
        claim.verification !== 'exact-text-selection' ||
        (locator.kind === 'json-pointer' && document.mediaType !== 'application/json')
      )
        invalid(
          'Text and JSON evidence selections must retain their actual source media and verification.'
        );
    }
    const newLots = new Map<
      string,
      { readonly lotId: string; readonly materialId: string; readonly definition: string }
    >();
    for (const component of arrival.components) {
      const choice = component.choice;
      const target = component.target;
      if (component.key !== choice.componentKey || component.key !== target.componentKey)
        invalid('Recorded component, choice and target keys must agree exactly.');
      if (component.packageKey !== null && !packages.has(component.packageKey))
        invalid('A received component must reference an original listed package.');
      const physical =
        choice.kind === 'identified' ||
        choice.kind === 'unidentified-physical' ||
        choice.kind === 'unobserved-physical';
      if (!physical) {
        if (
          target.vesselId !== null ||
          target.stockId !== null ||
          target.lotId !== null ||
          component.receivedQuantity !== null
        )
          invalid('Missing or evidence-only components cannot claim physical stock.');
        continue;
      }
      if (target.vesselId === null || !Object.hasOwn(state.vessels, target.vesselId))
        invalid('Physical receiving must retain its original existing vessel identity.');
      if (vesselIds.has(target.vesselId))
        invalid('Distinct arrival components cannot duplicate a received vessel.');
      vesselIds.add(target.vesselId);
      if (
        choice.vessel.placement.kind === 'located' &&
        !Object.hasOwn(state.storage, choice.vessel.placement.storageId)
      )
        invalid('Original receiving placements must retain their referenced storage.');
      if (choice.kind !== 'identified') {
        if (target.stockId !== null || target.lotId !== null || component.receivedQuantity !== null)
          invalid('Unresolved received contents cannot claim identified stock or quantity.');
        continue;
      }
      const stock = target.stockId === null ? undefined : state.stocks[target.stockId];
      const lot = target.lotId === null ? undefined : state.lots[target.lotId];
      if (
        !stock ||
        (choice.lot.kind === 'unattributed'
          ? target.lotId !== null
          : !lot || lot.materialId !== choice.materialId) ||
        stock.vesselId !== target.vesselId ||
        stock.materialId !== choice.materialId
      )
        invalid('An original identified receipt must retain its scientific and physical targets.');
      if (stockIds.has(stock.id))
        invalid('Distinct arrival components cannot duplicate original stock.');
      stockIds.add(stock.id);
      if (
        inventoryTableCanonicalJson(component.receivedQuantity) !==
        inventoryTableCanonicalJson(choice.quantity)
      )
        invalid('Original received amounts must retain their exact canonical admission snapshot.');
      if ((choice.quantity.kind === 'unknown') !== (choice.quantityBasis.kind === 'unknown'))
        invalid('Unknown receiving amounts require an explicit unknown basis.');
      if (choice.lot.kind === 'existing') {
        if (choice.lot.lotId !== target.lotId)
          invalid('Original existing-lot choices must retain their exact target.');
      } else if (choice.lot.kind === 'new') {
        if (
          !lot ||
          arrival.supplier === null ||
          component.componentBatch === null ||
          arrival.supplier !== choice.lot.supplier ||
          component.componentBatch !== choice.lot.lotNumber
        )
          invalid('New received lots require exactly observed supplier and component batch facts.');
        const previous = newLots.get(choice.lot.lotKey);
        const definition = inventoryTableCanonicalJson(choice.lot);
        if (
          previous &&
          (previous.lotId !== target.lotId ||
            previous.materialId !== choice.materialId ||
            previous.definition !== definition)
        )
          invalid(
            'Shared new-lot keys must retain one scientific identity and receiving definition.'
          );
        newLots.set(choice.lot.lotKey, {
          lotId: lot.id,
          materialId: choice.materialId,
          definition,
        });
        if (
          lot.origin.kind !== 'received' ||
          lot.origin.supplier !== choice.lot.supplier ||
          lot.origin.lotNumber !== choice.lot.lotNumber
        )
          invalid('An original new received lot must retain its immutable supplier definition.');
      }
      if (choice.quantityBasis.kind === 'supplier-declared') {
        const claim = claims.get(choice.quantityBasis.claimKey);
        if (
          !claim ||
          claim.claim.kind !== 'quantity' ||
          claim.subject.kind !== 'component' ||
          claim.subject.componentKey !== component.key ||
          choice.quantity.kind !== 'known'
        )
          invalid('Supplier-declared quantities require the exact component quantity claim.');
        const value = normalizeInventoryAmount({
          value: claim.claim.valueLexeme,
          unit: claim.claim.unitText as Parameters<typeof normalizeInventoryAmount>[0]['unit'],
        });
        if (value.value !== choice.quantity.value || value.unit !== choice.quantity.unit)
          invalid(
            'Supplier-declared received amounts cannot reinterpret incompatible source units or values.'
          );
      }
    }
  }
}
