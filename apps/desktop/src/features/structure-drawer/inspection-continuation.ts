import { buildMutationProteinContext } from '../alignment-manager/public/mutation-protein-context';
import { mutationProteinProductSchema } from '../alignment-manager/public/mutation-protein-product';
import { alleleStructureRequest } from './inspection-allele';
import { z } from 'zod';
import {
  createEntityReference,
  getEntityReference,
  updateEntityReference,
} from '../../db/entity-references';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { parseTextSequenceFileAsAnnotated } from '../../shared/parse-sequence-file';
import type { ProteinInspectionComputeTarget } from '../../shared/compute-jobs-ipc';
import { useWorkspaceStore, getCurrentWorkspaceScope } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import { openDocument } from '../document-opening/public/open-document';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
import { primerBindingToViewState } from '../sequence/public/primer-binding-viewstate';
import { readDesktopScientificDocument } from '../scientific-document/public/read-desktop-scientific-document';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { buildStructureDrawerRequestFromCds } from './api/build-structure-request';
import { inspectionProteinKey, type StructureInspection } from './structure-inspection';

const id = z.string().min(1).max(2000);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const interval = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((v) => v.end >= v.start);
const selections = z
  .array(
    z.object({
      target: z.object({
        moleculeId: id,
        moleculeKind: id,
        coordinateSystem: z.literal('residue'),
        label: z.string().max(2000).optional(),
        intervals: z.array(interval).max(500),
      }),
    })
  )
  .max(100);
const variantContext = z.object({
  product: mutationProteinProductSchema.optional(),
  trackId: id,
  trackLabel: z.string().max(2000),
  mutationId: id,
  position: z.number().int().positive(),
  referenceBase: z.string().max(24000),
  alternateBase: z.string().max(24000),
  residueIndices: z.array(z.number().int().nonnegative()).max(24000),
  mutationType: z.enum(['substitution', 'insertion', 'deletion']).optional(),
  proteinEffect: z
    .enum([
      'synonymous',
      'missense',
      'stop-gained',
      'conditional-stop',
      'frameshift',
      'in-frame-insertion',
      'in-frame-deletion',
    ])
    .optional(),
  changes: z
    .array(
      z.object({
        residue: z.number().int(),
        reference: z.string().max(24000),
        alternate: z.string().max(24000),
      })
    )
    .max(24000)
    .optional(),
  affectedTail: z
    .object({ start: z.number().int().positive(), end: z.number().int().positive() })
    .optional(),
});
const artifact = z.object({
  resultReferenceId: id.optional(),
  chainId: id.optional(),
  jobRecordId: id,
  provider: id,
  remoteId: id,
  toolId: id,
  workspaceRoot: id,
  filePath: id,
  format: z.enum(['pdb', 'cif']),
  sha256: digest,
  proteinSequenceSha256: digest,
  metrics: z.record(z.unknown()),
  provenance: z.record(z.string()),
});
const sourceView = z.object({
  variantAnalysisId: id.optional(),
  variantAnalysisIds: z.array(id).max(100).optional(),
  variantSelectedCallId: id.optional(),
});
const schema = z
  .object({
    kind: z.literal('protein-inspection-continuation'),
    version: z.literal(1),
    documentId: id,
    proteinKey: z.string().min(1).max(24000),
    sourceSha256: digest,
    alleleReferenceProteinKey: z.string().min(1).max(24000).optional(),
    referenceView: z
      .object({
        candidateId: id.optional(),
        savedViewReferenceId: id.optional(),
        prediction: artifact.optional(),
        continuationReferenceId: id.optional(),
      })
      .optional(),
    variantContext: variantContext.optional(),
    selections: selections.optional(),
    sourceView: sourceView.optional(),
    prediction: artifact.optional(),
    savedViewReferenceId: id.optional(),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 500_000,
    'The prediction inspection context exceeds its saved size limit.'
  );
type Continuation = z.infer<typeof schema>;

async function source(
  documentId: string,
  proteinKey: string,
  expectedDigest?: string,
  inspection?: Pick<Continuation, 'alleleReferenceProteinKey' | 'variantContext'>
) {
  const folders = useWorkspaceStore.getState().folders;
  const document = await resolveSequenceDocumentById(
    documentId,
    folders.map((f) => f.path)
  );
  if (document.documentId !== documentId)
    throw new Error('The prediction source resolved to another document.');
  const workspaceRoot = findWorkspaceRootForPath(
    folders.filter((f) => !f.pinned),
    document.sourcePath
  );
  if (!workspaceRoot)
    throw new Error('Mount the prediction’s original reference workspace to continue.');
  const read = await readDesktopScientificDocument({
    filePath: document.sourcePath,
    workspaceRoot,
  });
  if (!read.ok) throw new Error(read.error.message);
  const sourceSha256 = await coordinateDigest(read.document.content);
  if (expectedDigest && sourceSha256 !== expectedDigest)
    throw new Error(
      'The reference file changed since this prediction was submitted. Reopen and review its mutations before submitting a new prediction.'
    );
  const sequence = parseTextSequenceFileAsAnnotated(
    read.document.content,
    document.sourcePath
  ).sequence;
  let request = (sequence.annotations ?? [])
    .filter((feature) => feature.type.toUpperCase() === 'CDS')
    .map((cds) => buildStructureDrawerRequestFromCds({ cds, sequence, entityId: documentId }))
    .find(
      (candidate) =>
        candidate &&
        inspectionProteinKey(candidate) === (inspection?.alleleReferenceProteinKey ?? proteinKey)
    );
  if (!request || request.refusal)
    throw new Error(
      'The saved reference does not contain this exact protein revision. Save and reopen the reference before predicting it.'
    );
  if (inspection?.variantContext) {
    const context = inspection.variantContext;
    const derived = buildMutationProteinContext({
      sequence,
      documentId,
      trackId: context.trackId,
      trackLabel: context.trackLabel,
      mutation: {
        id: context.mutationId,
        position: context.position,
        referenceBase: context.referenceBase,
        alternateBase: context.alternateBase,
        type:
          context.mutationType ??
          (!context.referenceBase
            ? 'insertion'
            : !context.alternateBase
              ? 'deletion'
              : 'substitution'),
        length: Math.max(context.referenceBase.length, context.alternateBase.length),
      },
    });
    if (!derived.ok) throw new Error(derived.reason);
    if (inspectionProteinKey(derived.request) !== inspectionProteinKey(request))
      throw new Error('The saved allele belongs to another coding feature.');
    request = inspection.alleleReferenceProteinKey
      ? alleleStructureRequest(derived.request)
      : derived.request;
  } else if (inspection?.alleleReferenceProteinKey) {
    throw new Error('The allele prediction has no original DNA evidence.');
  }
  if (inspectionProteinKey(request) !== proteinKey)
    throw new Error('The saved allele does not encode this exact protein revision.');
  return {
    document,
    workspaceRoot,
    sourceSha256,
    request: { ...request, sourceWorkspaceRoot: workspaceRoot },
  };
}

function currentSourceView(documentId: string) {
  const canvas = useCanvasStore.getState();
  const location = canvas.findTab('sequence', documentId);
  const view =
    location &&
    canvas.panels[location.panelId].tabs.find((tab) => tab.id === location.tabId)?.viewState;
  return view ? sourceView.parse(view) : undefined;
}

export async function createInspectionContinuation(
  inspection: StructureInspection
): Promise<string> {
  const documentId = inspection.request.entityId!;
  const proteinKey = inspectionProteinKey(inspection.request);
  const alleleReferenceProteinKey = inspection.request.alleleOf
    ? inspectionProteinKey(inspection.request.alleleOf)
    : undefined;
  const verified = await source(documentId, proteinKey, undefined, {
    alleleReferenceProteinKey,
    variantContext: inspection.request.variantContext,
  });
  const data = schema.parse({
    kind: 'protein-inspection-continuation',
    version: 1,
    documentId,
    proteinKey,
    sourceSha256: verified.sourceSha256,
    alleleReferenceProteinKey,
    referenceView: alleleReferenceProteinKey
      ? inspection.retainedProteinViews?.[alleleReferenceProteinKey]
      : undefined,
    variantContext: inspection.request.variantContext,
    selections: inspection.selections,
    sourceView: currentSourceView(documentId),
  });
  const row = await createEntityReference({
    entityType: 'structure-inspection',
    displayLabel: inspection.request.cdsLabel ?? 'Protein prediction',
    locator: `entity://structure/inspection-continuation:${crypto.randomUUID()}`,
    data,
    deepLinkParams: null,
    source: 'compute',
    workspaceScope: getCurrentWorkspaceScope(),
    workspaceRootPath: verified.workspaceRoot,
  });
  return row.id;
}
async function readContinuation(referenceId: string): Promise<Continuation> {
  const row = await getEntityReference(referenceId);
  if (!row?.data || row.data.length > 500_000)
    throw new Error('The prediction’s saved inspection context is missing or invalid.');
  return schema.parse(JSON.parse(row.data));
}
export async function loadInspectionContinuation(target: ProteinInspectionComputeTarget) {
  if (!target.continuationReferenceId)
    throw new Error(
      'This older job has no saved inspection context. Reopen its reference mutation to continue.'
    );
  const context = await readContinuation(target.continuationReferenceId);
  if (context.documentId !== target.documentId || context.proteinKey !== target.proteinKey)
    throw new Error('The saved inspection context belongs to another prediction destination.');
  const verified = await source(
    context.documentId,
    context.proteinKey,
    context.sourceSha256,
    context
  );
  if ((await coordinateDigest(verified.request.translation)) !== target.proteinSequenceSha256)
    throw new Error('The saved inspection context belongs to another protein sequence.');
  const moleculeId = verified.request.residueMolecule?.moleculeId;
  for (const selection of context.selections ?? []) {
    if (
      selection.target.moleculeId !== moleculeId ||
      selection.target.intervals.some((i) => i.end >= verified.request.translation.length)
    )
      throw new Error('The saved residue selection does not belong to this protein.');
  }
  return {
    ...verified,
    context,
    request: verified.request,
    retainedProteinViews:
      context.referenceView && verified.request.alleleOf
        ? {
            [inspectionProteinKey(verified.request.alleleOf)]: {
              ...context.referenceView,
              request: verified.request.alleleOf,
            },
          }
        : undefined,
  };
}
export async function openContinuationSource(
  loaded: Awaited<ReturnType<typeof loadInspectionContinuation>>
) {
  const existing = useCanvasStore.getState().findTab('sequence', loaded.context.documentId);
  if (existing) return;
  const variant = loaded.context.variantContext;
  const opened = await openDocument({
    target: { kind: 'sequence-document', document: loaded.document.ref },
    label: loaded.document.name ?? loaded.document.sourcePath.split(/[\\/]/).pop(),
    placement: { kind: 'smart' },
    navigation: {
      ...loaded.context.sourceView,
      ...(variant
        ? {
            ...primerBindingToViewState(
              variant.position,
              variant.position + Math.max(1, variant.referenceBase.length) - 1
            ),
            alignmentReviewRequestId: crypto.randomUUID(),
          }
        : {}),
    },
  });
  if (opened.status !== 'presented')
    throw new Error(
      'message' in opened ? opened.message : 'The prediction reference could not be reopened.'
    );
  if (!useCanvasStore.getState().findTab('sequence', loaded.context.documentId))
    throw new Error('The reopened reference has a different document identity.');
}

export async function saveInspectionContinuation(inspection: StructureInspection): Promise<void> {
  if (!inspection.continuationReferenceId) return;
  const previous = await readContinuation(inspection.continuationReferenceId);
  if (
    previous.documentId !== inspection.request.entityId ||
    previous.proteinKey !== inspectionProteinKey(inspection.request)
  )
    throw new Error('The prediction context changed before it could be saved.');
  const data = schema.parse({
    ...previous,
    sourceView: currentSourceView(previous.documentId) ?? previous.sourceView,
    referenceView: previous.alleleReferenceProteinKey
      ? (inspection.retainedProteinViews?.[previous.alleleReferenceProteinKey] ??
        previous.referenceView)
      : undefined,
    variantContext: inspection.request.variantContext,
    selections: inspection.selections,
    prediction: inspection.prediction,
    savedViewReferenceId: inspection.savedViewReferenceId,
  });
  await updateEntityReference(inspection.continuationReferenceId, { data });
}
