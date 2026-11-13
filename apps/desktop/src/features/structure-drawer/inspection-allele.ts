import type { ResidueSelection } from '@waypoint/workspace-editor';
import { useCanvasStore } from '../canvas/public/store';
import { getWorkspaceResidueSelectionsStore } from './state/selected-codon-registry';
import {
  buildIdentityRequestKey,
  buildProteinSequenceIdentity,
  makeIdentityEvidence,
  sha256Hex,
} from './api/protein-identity';
import {
  inspectionProteinKey,
  openStructureInspection,
  structureInspectionId,
} from './structure-inspection';
import type { StructureDrawerRequest } from './types/structure-drawer';
import { getStructureInspectionSession } from './state/structure-inspection-sessions';

export function alleleStructureRequest(reference: StructureDrawerRequest): StructureDrawerRequest {
  if (reference.alleleOf) return reference;
  const context = reference.variantContext;
  const product = context?.product;
  if (!context || product?.status !== 'complete')
    throw new Error(
      product?.status === 'unresolved'
        ? product.reason
        : 'Inspect a translated allele before opening its product.'
    );
  const alleleId = sha256Hex(
    JSON.stringify([
      inspectionProteinKey(reference),
      context.position,
      context.referenceBase,
      context.alternateBase,
    ])
  );
  const evidence = [
    makeIdentityEvidence({
      kind: 'allele_translation',
      source: 'waypoint',
      confidence: 'authoritative',
      label: 'Single allele translated against the reference coding DNA',
      details: {
        position: context.position,
        reference: context.referenceBase,
        alternate: context.alternateBase,
        basis: product.basis,
      },
    }),
  ];
  const sequence = buildProteinSequenceIdentity({
    lookupSequence: product.sequence,
    source: 'allele_translation',
    startCodon: null,
    initiatorNormalized: false,
    evidenceIds: evidence.map((e) => e.id),
  });
  if (!sequence) throw new Error('The allele does not encode a supported prediction sequence.');
  const moleculeId = `${reference.residueMolecule?.moleculeId ?? reference.entityId}:allele:${alleleId}`;
  return {
    entityId: reference.entityId,
    sourceWorkspaceRoot: reference.sourceWorkspaceRoot,
    translation: product.sequence,
    moleculeType: 'protein',
    cdsLabel: `${reference.cdsLabel ?? 'Protein'} · ${context.referenceBase || '∅'}${context.position}${context.alternateBase || '∅'}`,
    identityRequestKey: buildIdentityRequestKey(alleleId, sequence.identityKey),
    residueMolecule: {
      moleculeId,
      moleculeKind: 'protein',
      label: 'Single-allele protein product',
    },
    proteinIdentity: {
      schemaVersion: 2,
      sequence,
      evidence,
      externalProteins: [],
      resolutionSets: [],
      structures: [],
    },
    hints: {},
    variantContext: context,
    alleleOf: reference,
  };
}

export function selectInspectionProteinProduct(
  documentId: string,
  product: 'reference' | 'allele'
) {
  const canvas = useCanvasStore.getState();
  const where = canvas.findTab('structure', structureInspectionId(documentId));
  const current =
    where &&
    canvas.panels[where.panelId].tabs.find((t) => t.id === where.tabId)?.structureInspection;
  if (!current) throw new Error('Inspect a mutation before choosing its protein product.');
  const reference = current.request.comparisonOf ?? current.request.alleleOf ?? current.request;
  const request = product === 'allele' ? alleleStructureRequest(reference) : reference;
  if (inspectionProteinKey(current.request) === inspectionProteinKey(request))
    return {
      request: current.request,
      product: current.request.variantContext?.product,
      status: 'pending' as const,
    };
  const context = reference.variantContext;
  let indices = context?.residueIndices ?? [];
  if (product === 'allele') {
    const mapping = context?.product;
    indices =
      mapping?.status === 'complete'
        ? mapping.alternateToReference.flatMap((index, alternate) =>
            index !== null && indices.includes(index) ? [alternate] : []
          )
        : [];
  }
  const selections: ResidueSelection[] =
    current.retainedProteinViews?.[inspectionProteinKey(request)]?.selections ??
    (indices.length && request.residueMolecule
      ? [
          {
            target: {
              ...request.residueMolecule,
              coordinateSystem: 'residue',
              intervals: indices.map((index) => ({ start: index, end: index })),
            },
          },
        ]
      : []);
  const reason = openStructureInspection(request, selections, {});
  if (reason) throw new Error(reason);
  getWorkspaceResidueSelectionsStore(documentId)?.set(selections);
  return { request, product: context?.product, status: 'pending' as const };
}

function inspectionContext(documentId: string) {
  const canvas = useCanvasStore.getState();
  const where = canvas.findTab('structure', structureInspectionId(documentId));
  const inspection =
    where &&
    canvas.panels[where.panelId].tabs.find((t) => t.id === where.tabId)?.structureInspection;
  if (!inspection) throw new Error('No protein inspection is open for this document.');
  const session = getStructureInspectionSession(
    where.tabId,
    inspectionProteinKey(inspection.request)
  );
  return { inspection, session };
}

export function inspectionProteinProductSummary(documentId: string) {
  const { inspection, session } = inspectionContext(documentId);
  const runtime = session.getState();
  const currentRuntime = runtime.request === inspection.request && runtime.status !== 'idle';
  return {
    proteinProduct: inspection.request.comparisonOf
      ? ('comparison' as const)
      : inspection.request.alleleOf
        ? ('allele' as const)
        : ('reference' as const),
    sequence: inspection.request.translation,
    alleleProduct: inspection.request.variantContext?.product,
    inspectionTarget: {
      document_id: documentId,
      protein_key: inspectionProteinKey(inspection.request),
    },
    structureViewId: inspection.viewSettings?.structureViewId,
    structureError: currentRuntime ? runtime.error : null,
    structureStatus: currentRuntime
      ? runtime.status
      : inspection.prediction || inspection.savedViewReferenceId
        ? 'restoring'
        : inspection.request.alleleOf
          ? 'awaiting-prediction'
          : 'resolving',
  };
}

export async function waitForInspectionProteinProduct(documentId: string, signal?: AbortSignal) {
  const { inspection, session } = inspectionContext(documentId);
  const terminal = new Set(['ready', 'no_match', 'error', 'awaiting-prediction']);
  const read = () => {
    if (inspectionContext(documentId).inspection.request !== inspection.request)
      throw new Error(
        'The protein inspection changed while waiting. Inspect the current selection again.'
      );
    return inspectionProteinProductSummary(documentId);
  };
  if (signal?.aborted) throw new Error('Stopped waiting for protein inspection.');
  if (!terminal.has(read().structureStatus)) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribeSession = () => {};
      let unsubscribeCanvas = () => {};
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribeSession();
        unsubscribeCanvas();
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('Stopped waiting for protein inspection.'));
      const timeout = setTimeout(() => finish(), 20_000);
      const observe = () => {
        try {
          if (terminal.has(read().structureStatus)) finish();
        } catch (error) {
          finish(error);
        }
      };
      unsubscribeSession = session.subscribe(observe);
      unsubscribeCanvas = useCanvasStore.subscribe(observe);
      signal?.addEventListener('abort', abort, { once: true });
      observe();
    });
  }
  const protein = read();
  const message =
    protein.structureStatus === 'ready'
      ? 'The protein viewer is ready. Read mol_get_state to verify the mapped residues and protein hash, then apply the measurement and save the view.'
      : protein.structureStatus === 'awaiting-prediction'
        ? 'This allele needs its own coordinates. For a mutation overlay on existing reference coordinates, repeat the inspection with proteinProduct reference. Predict the allele only when the user requests its own structure.'
        : protein.structureStatus === 'no_match'
          ? 'Structure lookup completed without matching coordinates. Explain this result and use the prediction workflow if requested.'
          : protein.structureStatus === 'error'
            ? 'Structure lookup or rendering failed. Report the returned structureError; do not claim that a structure is visible.'
            : 'The structure is still loading. Repeat this same inspection to wait for completion. An empty viewer or prediction list during loading does not mean no structure exists.';
  return { ...protein, message };
}

export function inspectionAlleleProvenance(request: StructureDrawerRequest) {
  const reference = request.alleleOf;
  const context = request.variantContext;
  const product = context?.product;
  if (!reference || !context || product?.status !== 'complete') return undefined;
  return {
    basis: 'single-allele' as const,
    documentId: request.entityId!,
    position: context.position,
    referenceBase: context.referenceBase,
    alternateBase: context.alternateBase,
    referenceProteinSha256: sha256Hex(reference.translation),
    proteinSequenceSha256: sha256Hex(request.translation),
    referenceLength: reference.translation.length,
    proteinLength: request.translation.length,
    alternateToReference: product.alternateToReference,
  };
}
