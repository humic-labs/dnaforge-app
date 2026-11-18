import { parseProtocolPackageForDisplay } from '@waypoint/domain-services';
import { scientificPackageKindForMetaPath } from '../../shared/scientific-package';
import { nativeEntityReferenceIdFromHref } from '../../shared/native-entity-reference';
import { parsePaperProtocolWorkflow, type PaperProtocolWorkflow } from './paper-protocol-model';
import {
  readSavedFormulaResult,
  type SavedFormulaResult,
} from '../../shared/source-formula-result';

export const SCIENTIFIC_DOCUMENT_SUFFIXES = {
  protocol: '.dnaforge-protocol.json',
  protocolRun: '.dnaforge-protocol-run.json',
  legacyCollection: '.dnaforge-collection.json',
} as const;

type JsonRecord = Record<string, unknown>;

export type ScientificDocumentLink =
  | { kind: 'local'; href: string; destinationTargetId: string }
  | { kind: 'external'; href: string };

export type ScientificRichTextSegment = {
  text: string;
  link: ScientificDocumentLink | null;
};

export type ScientificRichText = {
  text: string;
  segments: ScientificRichTextSegment[];
};

export type ScientificSourceSpan = {
  sourceId: string;
  sectionId: string;
  sectionTitle: string;
  start: number;
  end: number;
  sha256: string;
};

export type ScientificPaperSourceSection = {
  sectionId: string;
  sectionTitle: string;
  text: string;
  offsetBase: number;
  order: number;
  sha256: string;
};

export type ScientificPaperSource = {
  sourceId: string;
  kind: string;
  title: string;
  sections: ScientificPaperSourceSection[];
};

export type ScientificPaperSourceBundle = {
  immutable: true;
  sources: ScientificPaperSource[];
};

export type ScientificPdfSource = {
  sourceId: string;
  title: string;
  workspacePath: string;
  sha256: string;
  pageCount: number;
};

export type ScientificPdfRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScientificPdfAnchor = {
  anchorId: string;
  sourceId: string;
  page: number;
  quote: string;
  rects: ScientificPdfRect[];
};

export type ScientificProtocolDocument = {
  kind: 'protocol';
  title: string;
  mutable: boolean;
  raw: JsonRecord;
  overview: ScientificRichText;
  overviewText: string;
  steps: Array<{
    id: string;
    ordinal: number;
    title: string;
    content: ScientificRichText;
    text: string;
    sourceStatus: string | null;
    sourceSpans: ScientificSourceSpan[];
    pdfAnchors: ScientificPdfAnchor[];
    puntId: string | null;
  }>;
  inputs: Array<{ key: string; label: string; required: boolean; type: string }>;
  outputs: Array<{ key: string; label: string; required: boolean; type: string }>;
  versionLabel: string;
  sourceUrl: string | null;
  sourceBundle: ScientificPaperSourceBundle | null;
  pdfSources: ScientificPdfSource[];
  paperProtocol: PaperProtocolWorkflow | null;
};

type ScientificProtocolRunCell = { value: string; savedResult: SavedFormulaResult | null };

export type ScientificProtocolRunDocument = {
  kind: 'protocol_run';
  title: string;
  mutable: boolean;
  raw: JsonRecord;
  status: 'in_progress' | 'completed';
  protocolName: string;
  protocolVersion: string;
  inputs: Array<{ key: string; label: string; value: string }>;
  outputs: Array<{ key: string; label: string; value: string }>;
  measurements: Array<{ key: string; label: string; value: string }>;
  tables: Array<{ id: string; name: string; cells: ScientificProtocolRunCell[][] }>;
  amendments: Array<{ id: string; sequence: number; at: string; reason: string; path: string }>;
  sourceUrl: string | null;
};

export type ScientificProteinDocument = {
  kind: 'protein';
  title: string;
  mutable: true;
  identifier: string;
  aminoAcids: string;
};

export type ScientificLegacyCollectionDocument = {
  kind: 'legacy_collection';
  title: string;
  mutable: false;
  raw: JsonRecord;
  id: string;
  parentCollectionId: string | null;
  childCollectionIds: string[];
  memberObjectIds: string[];
  excludedChildren: Array<{ id: string; name: string }>;
  sourceUrl: string | null;
};

export type ScientificDocument =
  | ScientificProtocolDocument
  | ScientificProtocolRunDocument
  | ScientificLegacyCollectionDocument
  | ScientificProteinDocument;

const STANDARD_PROTEIN_ALPHABET = /^[ACDEFGHIKLMNPQRSTVWY]+$/;
const AMENDMENT_PATH = /^\/(inputs|outputs|measurements|tables)\/[A-Za-z0-9_/-]+$/;

export function parseScientificDocument(path: string, text: string): ScientificDocument {
  const lower = fileName(path).toLowerCase();
  const packageKind = scientificPackageKindForMetaPath(path);
  if (lower.endsWith('.faa')) return parseProtein(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This scientific document is not valid JSON.');
  }
  const raw = record(parsed, 'Scientific document must be an object.');
  if (
    (lower.endsWith(SCIENTIFIC_DOCUMENT_SUFFIXES.protocol) || packageKind === 'protocol') &&
    raw.schema === 'dnaforge.protocol.v1' &&
    raw.kind === 'protocol'
  ) {
    parseProtocolPackageForDisplay(text);
    return parseProtocol(raw);
  }
  if (
    (lower.endsWith(SCIENTIFIC_DOCUMENT_SUFFIXES.protocolRun) || packageKind === 'protocol-run') &&
    raw.schema === 'dnaforge.protocol-run.v1' &&
    raw.kind === 'protocol_run'
  ) {
    parseProtocolPackageForDisplay(text);
    return parseProtocolRun(raw);
  }
  if (
    lower.endsWith(SCIENTIFIC_DOCUMENT_SUFFIXES.legacyCollection) &&
    raw.schema === 'dnaforge.collection.v1' &&
    raw.kind === 'collection'
  ) {
    return parseLegacyCollection(raw);
  }
  throw new Error('The file extension and scientific document schema do not match.');
}

export function serializeScientificDocument(document: ScientificDocument): string {
  if (document.kind === 'protein') {
    const description = singleLine(document.title);
    const header = description
      ? `>${document.identifier} ${description}`
      : `>${document.identifier}`;
    const lines = document.aminoAcids.match(/.{1,60}/g) ?? [];
    return `${header}\n${lines.join('\n')}\n`;
  }
  return `${JSON.stringify(document.raw, null, 2)}\n`;
}

export function renameScientificDocument(
  document: ScientificDocument,
  nextTitle: string
): ScientificDocument {
  const title = requiredText(nextTitle, 'Title');
  if (!document.mutable) {
    throw new Error(
      document.kind === 'protocol'
        ? 'Finalized protocol is immutable until it is reopened.'
        : 'Completed protocol runs are immutable.'
    );
  }
  if (document.kind === 'protein') return { ...document, title };
  const raw = cloneRecord(document.raw);
  raw.title = title;
  if (document.kind === 'protocol') {
    advancePaperProtocolDraft(raw);
    return parseProtocol(raw);
  }
  return { ...document, title, raw };
}

export function updateProteinSequence(
  document: ScientificProteinDocument,
  sequence: string
): ScientificProteinDocument {
  const aminoAcids = sequence.replace(/\s+/g, '').toUpperCase();
  if (!aminoAcids || !STANDARD_PROTEIN_ALPHABET.test(aminoAcids)) {
    throw new Error('Protein sequence must use the standard amino-acid alphabet.');
  }
  return { ...document, aminoAcids };
}

export function updateProtocolOverview(
  document: ScientificProtocolDocument,
  text: string
): ScientificProtocolDocument {
  assertProtocolMutable(document);
  const raw = cloneRecord(document.raw);
  raw.overview = plainTextTipTapDocument(text);
  advancePaperProtocolDraft(raw);
  return parseProtocol(raw);
}

export function updateProtocolStep(
  document: ScientificProtocolDocument,
  stepId: string,
  patch: { title?: string; contentText?: string }
): ScientificProtocolDocument {
  assertProtocolMutable(document);
  const raw = cloneRecord(document.raw);
  const steps = array(raw.steps, 'Protocol steps must be an array.').map((entry) =>
    cloneRecord(record(entry, 'Protocol step must be an object.'))
  );
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`Protocol step ${stepId} does not exist.`);
  if (patch.title !== undefined) steps[index].title = requiredText(patch.title, 'Step title');
  if (patch.contentText !== undefined) {
    steps[index].content = plainTextTipTapDocument(patch.contentText);
    if (
      'sourceStatus' in steps[index] ||
      'sourceSpans' in steps[index] ||
      'pdfAnchors' in steps[index]
    ) {
      steps[index].sourceStatus = 'edited';
      steps[index].sourceSpans = [];
      steps[index].pdfAnchors = [];
    }
  }
  raw.steps = steps;
  advancePaperProtocolDraft(
    raw,
    patch.contentText === undefined ? undefined : { stepId, kind: 'edited' }
  );
  return parseProtocol(raw);
}

export async function reviseProtocolStepWithHistory(
  document: ScientificProtocolDocument,
  stepId: string,
  patch: { title?: string; contentText?: string },
  revision: { actor: string; at: string }
): Promise<{ document: ScientificProtocolDocument; revisionId: string }> {
  if (patch.title === undefined && patch.contentText === undefined) {
    throw new Error('Protocol revision must change a title or step content.');
  }
  if (!Number.isFinite(Date.parse(revision.at))) {
    throw new Error('Protocol revision timestamp is invalid.');
  }
  const actor = requiredText(revision.actor, 'Protocol revision actor');
  const beforeSteps = array(document.raw.steps, 'Protocol steps must be an array.');
  const before = beforeSteps.find((entry) => optionalRecord(entry)?.id === stepId);
  if (!before) throw new Error(`Protocol step ${stepId} does not exist.`);

  const updated = updateProtocolStep(document, stepId, patch);
  const afterSteps = array(updated.raw.steps, 'Protocol steps must be an array.');
  const after = afterSteps.find((entry) => optionalRecord(entry)?.id === stepId);
  if (!after) throw new Error(`Protocol step ${stepId} does not exist after revision.`);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error('Protocol revision did not change the step.');
  }

  const raw = cloneRecord(updated.raw);
  const priorRevisions =
    raw.revisions === undefined
      ? []
      : array(raw.revisions, 'Protocol revisions must be an array.').map((entry) =>
          cloneRecord(record(entry, 'Protocol revision must be an object.'))
        );
  const at = new Date(revision.at).toISOString();
  const revisionId = `protocol-revision-${(
    await sha256Hex(
      JSON.stringify({
        protocolId: raw.id,
        stepId,
        actor,
        at,
        before,
        after,
      })
    )
  ).slice(0, 20)}`;
  raw.revisions = [
    ...priorRevisions,
    {
      id: revisionId,
      kind: 'protocol_step_revision',
      actor,
      at,
      stepId,
      before: cloneRecord(record(before, 'Protocol revision before-step must be an object.')),
      after: cloneRecord(record(after, 'Protocol revision after-step must be an object.')),
    },
  ];
  return { document: parseProtocol(raw), revisionId };
}

export async function addProtocolStep(
  document: ScientificProtocolDocument,
  input: { title: string; contentText?: string }
): Promise<ScientificProtocolDocument> {
  assertProtocolMutable(document);
  const title = requiredText(input.title, 'Step title');
  const contentText = input.contentText ?? '';
  const raw = cloneRecord(document.raw);
  const steps = array(raw.steps, 'Protocol steps must be an array.').map((entry) =>
    cloneRecord(record(entry, 'Protocol step must be an object.'))
  );
  const existingIds = steps
    .map((step) => requiredText(step.id, 'Protocol step ID'))
    .sort()
    .join('\u0000');
  const digest = await sha256Hex(
    `${requiredText(raw.id, 'Protocol ID')}\u0000${existingIds}\u0000${title}\u0000${contentText}`
  );
  const id = `dnaforge-protocol-step-${digest.slice(0, 20)}`;
  if (steps.some((step) => step.id === id)) {
    throw new Error('The deterministic protocol step identity already exists.');
  }
  steps.push({
    id,
    sourceStepId: `local-${digest.slice(0, 20)}`,
    ordinal: steps.length + 1,
    title,
    content: plainTextTipTapDocument(contentText),
  });
  raw.steps = steps;
  advancePaperProtocolDraft(raw, { stepId: id, kind: 'added' });
  return parseProtocol(raw);
}

export function deleteProtocolStep(
  document: ScientificProtocolDocument,
  stepId: string
): ScientificProtocolDocument {
  assertProtocolMutable(document);
  const raw = cloneRecord(document.raw);
  const steps = array(raw.steps, 'Protocol steps must be an array.').map((entry) =>
    cloneRecord(record(entry, 'Protocol step must be an object.'))
  );
  if (steps.length <= 1) throw new Error('A protocol must retain at least one step.');
  const next = steps.filter((step) => step.id !== stepId);
  if (next.length === steps.length) throw new Error(`Protocol step ${stepId} does not exist.`);
  raw.steps = normalizeStepOrdinals(next);
  advancePaperProtocolDraft(raw, { stepId, kind: 'deleted' });
  return parseProtocol(raw);
}

export function moveProtocolStep(
  document: ScientificProtocolDocument,
  stepId: string,
  direction: 'up' | 'down'
): ScientificProtocolDocument {
  assertProtocolMutable(document);
  const raw = cloneRecord(document.raw);
  const steps = array(raw.steps, 'Protocol steps must be an array.').map((entry) =>
    cloneRecord(record(entry, 'Protocol step must be an object.'))
  );
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`Protocol step ${stepId} does not exist.`);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= steps.length) return document;
  [steps[index], steps[target]] = [steps[target], steps[index]];
  raw.steps = normalizeStepOrdinals(steps);
  advancePaperProtocolDraft(raw);
  return parseProtocol(raw);
}

export async function appendProtocolRunTextAmendment(
  document: ScientificProtocolRunDocument,
  input: { path: string; reason: string; value: string; at?: string }
): Promise<ScientificProtocolRunDocument> {
  if (!document.mutable || document.status === 'completed') {
    throw new Error('Completed protocol runs are immutable.');
  }
  const path = requiredText(input.path, 'Amendment path');
  if (!AMENDMENT_PATH.test(path)) {
    throw new Error('Amendment path must target run inputs, outputs, measurements, or tables.');
  }
  const reason = requiredText(input.reason, 'Amendment reason');
  const value = requiredText(input.value, 'Amendment value');
  const at = input.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error('Amendment timestamp is invalid.');
  const raw = cloneRecord(document.raw);
  const prior = array(raw.amendments, 'Protocol run amendments must be an array.');
  const sequence = prior.length + 1;
  const digest = await sha256Hex(`${requiredText(raw.id, 'Protocol run ID')}:${sequence}:${at}`);
  const amendment = {
    id: `amendment-${sequence}-${digest.slice(0, 16)}`,
    sequence,
    at: new Date(at).toISOString(),
    actor: null,
    reason,
    path,
    value: { type: 'text', value },
  };
  raw.amendments = [...prior, amendment];
  return {
    ...document,
    raw,
    amendments: [
      ...document.amendments,
      { id: amendment.id, sequence, at: amendment.at, reason, path },
    ],
  };
}

export function migrationWorkspaceRootForDocument(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const marker = '/Benchling Imports/';
  const index = normalized.lastIndexOf(marker);
  return index < 0 ? null : normalized.slice(0, index);
}

export function migrationWorkspaceMarkerPath(path: string): string | null {
  const root = migrationWorkspaceRootForDocument(path);
  return root ? `${root}/.dnaforge/migration/workspace.json` : null;
}

export function richTextFromTipTap(value: unknown): ScientificRichText {
  const segments: ScientificRichTextSegment[] = [];
  collectTipTapSegments(value, segments, true);
  const normalized = mergeRichTextSegments(segments);
  return {
    text: normalized
      .map((segment) => segment.text)
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    segments: normalized,
  };
}

export function safeExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      Boolean(url.username) ||
      Boolean(url.password)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseProtocol(raw: JsonRecord): ScientificProtocolDocument {
  const rawSteps = array(raw.steps, 'Protocol steps must be an array.');
  const stepIds = rawSteps.map((entry, index) =>
    requiredText(
      record(entry, `Protocol step ${index + 1} must be an object.`).id,
      `Protocol step ${index + 1} ID`
    )
  );
  const paperProtocol =
    raw.paperProtocol === undefined || raw.paperProtocol === null
      ? null
      : parsePaperProtocolWorkflow(raw.paperProtocol, stepIds);
  const pdfSources = paperProtocol
    ? paperProtocol.sources.flatMap((source) =>
        source.kind === 'pdf'
          ? [
              {
                sourceId: source.sourceId,
                title: source.title,
                workspacePath: source.workspacePath,
                sha256: source.sha256.slice('sha256:'.length),
                pageCount: source.pageCount,
              },
            ]
          : []
      )
    : parsePdfSources(raw.pdfSources);
  const pdfSourcesById = new Map(pdfSources.map((source) => [source.sourceId, source]));
  const steps = rawSteps.map((entry, index) => {
    const step = record(entry, `Protocol step ${index + 1} must be an object.`);
    const content = richTextFromTipTap(step.content);
    const stepId = requiredText(step.id, `Protocol step ${index + 1} ID`);
    const canonicalPdfAnchors = paperProtocol?.evidence.flatMap((evidence) => {
      if (evidence.stepId !== stepId || evidence.locator.kind !== 'pdf_rects') return [];
      return [
        {
          anchorId: evidence.evidenceId,
          sourceId: evidence.sourceId,
          page: evidence.locator.page,
          quote: evidence.quote,
          rects: evidence.locator.rects,
        },
      ];
    });
    return {
      id: stepId,
      ordinal: finiteNumber(step.ordinal, `Protocol step ${index + 1} ordinal`),
      title: requiredText(step.title, `Protocol step ${index + 1} title`),
      content,
      text: content.text,
      sourceStatus: optionalText(step.sourceStatus),
      sourceSpans: parseSourceSpans(step.sourceSpans, `Protocol step ${index + 1}`),
      pdfAnchors:
        canonicalPdfAnchors ??
        parsePdfAnchors(step.pdfAnchors, `Protocol step ${index + 1}`, pdfSourcesById),
      puntId: nullableText(step.puntId),
    };
  });
  const version = record(raw.version, 'Protocol version must be an object.');
  const provenance = optionalRecord(raw.provenance);
  const overview = richTextFromTipTap(raw.overview);
  return {
    kind: 'protocol',
    title: requiredText(raw.title, 'Protocol title'),
    mutable: paperProtocol?.draft.state !== 'finalized',
    raw,
    overview,
    overviewText: overview.text,
    steps,
    inputs: parseSlotDeclarations(raw.inputs, 'inputs'),
    outputs: parseSlotDeclarations(raw.outputs, 'outputs'),
    versionLabel: requiredText(version.sourceVersionId, 'Protocol source version'),
    sourceUrl: optionalText(provenance?.sourceUrl),
    sourceBundle: parsePaperSourceBundle(raw.sourceBundle),
    pdfSources,
    paperProtocol,
  };
}

function assertProtocolMutable(document: ScientificProtocolDocument): void {
  if (!document.mutable) throw new Error('Finalized protocol is immutable until it is reopened.');
}

function advancePaperProtocolDraft(
  raw: JsonRecord,
  stepChange?: { stepId: string; kind: 'added' | 'edited' | 'deleted' }
): void {
  const workflow = optionalRecord(raw.paperProtocol);
  if (!workflow) return;
  const draft = cloneRecord(record(workflow.draft, 'Paper protocol draft must be an object.'));
  const revision = positiveInteger(draft.revision, 'Paper protocol draft revision') + 1;
  draft.revision = revision;
  draft.state = 'draft';
  workflow.draft = draft;

  if (stepChange) {
    workflow.evidence = array(
      workflow.evidence,
      'Paper protocol evidence must be an array.'
    ).filter((entry) => optionalRecord(entry)?.stepId !== stepChange.stepId);
    const remainingGaps = array(workflow.gaps, 'Paper protocol gaps must be an array.').filter(
      (entry) => optionalRecord(entry)?.stepId !== stepChange.stepId
    );
    workflow.gaps =
      stepChange.kind === 'deleted'
        ? remainingGaps
        : [
            ...remainingGaps,
            {
              gapId: `gap-user-${stepChange.kind}-${revision}-${stepChange.stepId}`,
              stepId: stepChange.stepId,
              missing:
                stepChange.kind === 'added'
                  ? 'This step was added by the user after extraction and has no source evidence.'
                  : 'This step was edited after extraction; its earlier exact evidence was invalidated.',
              attemptedResolution: ['Recorded the user correction in the draft revision.'],
            },
          ];
  }
  raw.paperProtocol = workflow;
}

function parsePdfSources(value: unknown): ScientificPdfSource[] {
  if (value === undefined || value === null) return [];
  return array(value, 'Protocol PDF sources must be an array.').map((entry, index) => {
    const source = record(entry, `Protocol PDF source ${index + 1} must be an object.`);
    const workspacePath = requiredText(
      source.workspacePath,
      `Protocol PDF source ${index + 1} project path`
    ).replace(/\\/g, '/');
    if (
      workspacePath.startsWith('/') ||
      /^[A-Za-z]:\//.test(workspacePath) ||
      workspacePath.split('/').some((segment) => segment === '..') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(workspacePath)
    ) {
      throw new Error(`Protocol PDF source ${index + 1} project path is invalid.`);
    }
    const pageCount = positiveInteger(
      source.pageCount,
      `Protocol PDF source ${index + 1} page count`
    );
    return {
      sourceId: requiredText(source.sourceId, `Protocol PDF source ${index + 1} ID`),
      title: requiredText(source.title, `Protocol PDF source ${index + 1} title`),
      workspacePath,
      sha256: sha256Digest(source.sha256, `Protocol PDF source ${index + 1} hash`),
      pageCount,
    };
  });
}

function parsePdfAnchors(
  value: unknown,
  label: string,
  sources: ReadonlyMap<string, ScientificPdfSource>
): ScientificPdfAnchor[] {
  if (value === undefined || value === null) return [];
  return array(value, `${label} PDF anchors must be an array.`).map((entry, index) => {
    const anchor = record(entry, `${label} PDF anchor ${index + 1} must be an object.`);
    const sourceId = requiredText(anchor.sourceId, `${label} PDF anchor ${index + 1} source ID`);
    const source = sources.get(sourceId);
    if (!source) throw new Error(`${label} PDF anchor ${index + 1} references an unknown source.`);
    const page = positiveInteger(anchor.page, `${label} PDF anchor ${index + 1} page`);
    if (page > source.pageCount) {
      throw new Error(`${label} PDF anchor ${index + 1} page exceeds the source page count.`);
    }
    const rects = array(
      anchor.rects,
      `${label} PDF anchor ${index + 1} rectangles must be an array.`
    ).map((rectEntry, rectIndex) => {
      const rect = record(
        rectEntry,
        `${label} PDF anchor ${index + 1} rectangle ${rectIndex + 1} must be an object.`
      );
      const parsed = {
        x: normalizedCoordinate(
          rect.x,
          `${label} PDF anchor ${index + 1} rectangle ${rectIndex + 1} x`
        ),
        y: normalizedCoordinate(
          rect.y,
          `${label} PDF anchor ${index + 1} rectangle ${rectIndex + 1} y`
        ),
        width: normalizedExtent(
          rect.width,
          `${label} PDF anchor ${index + 1} rectangle ${rectIndex + 1} width`
        ),
        height: normalizedExtent(
          rect.height,
          `${label} PDF anchor ${index + 1} rectangle ${rectIndex + 1} height`
        ),
      };
      if (parsed.x + parsed.width > 1 || parsed.y + parsed.height > 1) {
        throw new Error(
          `${label} PDF anchor ${index + 1} rectangle ${rectIndex + 1} exceeds the page.`
        );
      }
      return parsed;
    });
    if (rects.length === 0) throw new Error(`${label} PDF anchor ${index + 1} has no rectangles.`);
    return {
      anchorId: requiredText(anchor.anchorId, `${label} PDF anchor ${index + 1} ID`),
      sourceId,
      page,
      quote: exactText(anchor.quote, `${label} PDF anchor ${index + 1} quote`),
      rects,
    };
  });
}

function parsePaperSourceBundle(value: unknown): ScientificPaperSourceBundle | null {
  if (value === undefined || value === null) return null;
  const bundle = record(value, 'Paper source bundle must be an object.');
  if (bundle.schema !== 'dnaforge.paper-source-bundle.v1') {
    throw new Error('Paper source bundle schema is invalid.');
  }
  if (bundle.immutable !== true) throw new Error('Paper source bundle must be immutable.');
  const sources = array(bundle.sources, 'Paper source bundle sources must be an array.').map(
    (entry, sourceIndex) => {
      const source = record(entry, `Paper source ${sourceIndex + 1} must be an object.`);
      const sourceId = requiredText(source.sourceId, `Paper source ${sourceIndex + 1} ID`);
      return {
        sourceId,
        kind: requiredText(source.kind, `Paper source ${sourceIndex + 1} kind`),
        title: requiredText(source.title, `Paper source ${sourceIndex + 1} title`),
        sections: array(
          source.sections,
          `Paper source ${sourceIndex + 1} sections must be an array.`
        ).map((sectionEntry, sectionIndex) => {
          const section = record(
            sectionEntry,
            `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} must be an object.`
          );
          const text = exactText(
            section.text,
            `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} text`
          );
          const offsetBase = nonNegativeInteger(
            section.offsetBase,
            `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} offset`
          );
          return {
            sectionId: requiredText(
              section.sectionId,
              `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} ID`
            ),
            sectionTitle: requiredText(
              section.sectionTitle,
              `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} title`
            ),
            text,
            offsetBase,
            order: finiteNumber(
              section.order,
              `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} order`
            ),
            sha256: sha256Digest(
              section.sha256,
              `Paper source ${sourceIndex + 1} section ${sectionIndex + 1} hash`
            ),
          };
        }),
      };
    }
  );
  return { immutable: true, sources };
}

function parseSourceSpans(value: unknown, label: string): ScientificSourceSpan[] {
  if (value === undefined || value === null) return [];
  return array(value, `${label} source spans must be an array.`).map((entry, index) => {
    const span = record(entry, `${label} source span ${index + 1} must be an object.`);
    const start = nonNegativeInteger(span.start, `${label} source span ${index + 1} start`);
    const end = nonNegativeInteger(span.end, `${label} source span ${index + 1} end`);
    if (end < start) throw new Error(`${label} source span ${index + 1} ends before it starts.`);
    return {
      sourceId: requiredText(span.sourceId, `${label} source span ${index + 1} source ID`),
      sectionId: requiredText(span.sectionId, `${label} source span ${index + 1} section ID`),
      sectionTitle: optionalText(span.sectionTitle) ?? 'Source passage',
      start,
      end,
      sha256: sha256Digest(
        span.sha256 ?? span.textSha256,
        `${label} source span ${index + 1} hash`
      ),
    };
  });
}

function parseProtocolRun(raw: JsonRecord): ScientificProtocolRunDocument {
  if (raw.status !== 'in_progress' && raw.status !== 'completed') {
    throw new Error('Protocol run status is invalid.');
  }
  const status = raw.status;
  const immutable = raw.immutable === true;
  if (immutable !== (status === 'completed')) {
    throw new Error('Protocol run immutable state does not match completion status.');
  }
  const protocol = record(raw.protocol, 'Protocol run pin must be an object.');
  const provenance = optionalRecord(raw.provenance);
  const amendments = array(raw.amendments, 'Protocol run amendments must be an array.').map(
    (entry, index) => {
      const amendment = record(entry, `Protocol run amendment ${index + 1} must be an object.`);
      return {
        id: requiredText(amendment.id, `Protocol run amendment ${index + 1} ID`),
        sequence: finiteNumber(amendment.sequence, `Protocol run amendment ${index + 1} sequence`),
        at: requiredText(amendment.at, `Protocol run amendment ${index + 1} timestamp`),
        reason: requiredText(amendment.reason, `Protocol run amendment ${index + 1} reason`),
        path: requiredText(amendment.path, `Protocol run amendment ${index + 1} path`),
      };
    }
  );
  return {
    kind: 'protocol_run',
    title: requiredText(raw.title, 'Protocol run title'),
    mutable: !immutable,
    raw,
    status,
    protocolName: requiredText(protocol.name, 'Pinned protocol name'),
    protocolVersion: requiredText(protocol.pinnedVersionId, 'Pinned protocol version'),
    inputs: parseRunSlots(raw.inputs, 'inputs'),
    outputs: parseRunSlots(raw.outputs, 'outputs'),
    measurements: parseRunSlots(raw.measurements, 'measurements'),
    tables: parseRunTables(raw.tables),
    amendments,
    sourceUrl: optionalText(provenance?.sourceUrl),
  };
}

function parseProtein(text: string): ScientificProteinDocument {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const [header, ...body] = normalized.split('\n');
  if (!header?.startsWith('>')) throw new Error('Protein FASTA requires a header.');
  const headerText = header.slice(1).trim();
  const separator = headerText.search(/\s/);
  const identifier = requiredText(
    separator < 0 ? headerText : headerText.slice(0, separator),
    'Protein identifier'
  );
  const title = separator < 0 ? identifier : headerText.slice(separator).trim() || identifier;
  const aminoAcids = body.join('').replace(/\s+/g, '').toUpperCase();
  if (!aminoAcids || !STANDARD_PROTEIN_ALPHABET.test(aminoAcids)) {
    throw new Error('Protein FASTA must use the standard amino-acid alphabet.');
  }
  return { kind: 'protein', title, mutable: true, identifier, aminoAcids };
}

function parseSlotDeclarations(
  value: unknown,
  label: string
): Array<{ key: string; label: string; required: boolean; type: string }> {
  return array(value, `Protocol ${label} must be an array.`).map((entry, index) => {
    const slot = record(entry, `Protocol ${label} ${index + 1} must be an object.`);
    const valueType = record(slot.valueType, `Protocol ${label} ${index + 1} type is required.`);
    return {
      key: requiredText(slot.key, `Protocol ${label} ${index + 1} key`),
      label: requiredText(slot.label, `Protocol ${label} ${index + 1} label`),
      required: slot.required === true,
      type: requiredText(valueType.kind, `Protocol ${label} ${index + 1} type`),
    };
  });
}

function parseRunSlots(
  value: unknown,
  label: string
): Array<{ key: string; label: string; value: string }> {
  return array(value, `Protocol run ${label} must be an array.`).map((entry, index) => {
    const slot = record(entry, `Protocol run ${label} ${index + 1} must be an object.`);
    return {
      key: requiredText(slot.key, `Protocol run ${label} ${index + 1} key`),
      label: requiredText(slot.label, `Protocol run ${label} ${index + 1} label`),
      value: displayRunValue(slot.value),
    };
  });
}

function displayRunValue(value: unknown): string {
  const item = record(value, 'Protocol run value must be an object.');
  if (item.type === 'quantity') return requiredText(item.lexical, 'Quantity lexical value');
  if (item.type === 'record') return requiredText(item.label, 'Record label');
  if (item.type === 'attachment') return requiredText(item.fileName, 'Attachment filename');
  if (typeof item.value === 'string' || typeof item.value === 'number') return String(item.value);
  if (typeof item.value === 'boolean') return item.value ? 'True' : 'False';
  return 'Preserved value';
}

function parseRunTables(value: unknown): ScientificProtocolRunDocument['tables'] {
  return array(value, 'Protocol run tables must be an array.').map((entry, index) => {
    const table = record(entry, `Protocol run table ${index + 1} must be an object.`);
    const cells = array(table.cells, `Protocol run table ${index + 1} cells must be an array.`).map(
      (row, rowIndex) =>
        array(row, `Protocol run table ${index + 1} row ${rowIndex + 1} must be an array.`).map(
          (cell) => {
            const value = record(cell, 'Protocol run table cell must be an object.');
            const savedResult = readSavedFormulaResult(value);
            const rendered = value.computed ?? value.value;
            return {
              value: savedResult
                ? (savedResult.value ?? '')
                : rendered === undefined || rendered === null
                  ? ''
                  : String(rendered),
              savedResult,
            };
          }
        )
    );
    return {
      id: requiredText(table.id, `Protocol run table ${index + 1} ID`),
      name: requiredText(table.name, `Protocol run table ${index + 1} name`),
      cells,
    };
  });
}

function parseLegacyCollection(raw: JsonRecord): ScientificLegacyCollectionDocument {
  const provenance = optionalRecord(raw.provenance);
  return {
    kind: 'legacy_collection',
    title: requiredText(raw.title, 'Legacy folder title'),
    mutable: false,
    raw,
    id: requiredText(raw.id, 'Legacy folder ID'),
    parentCollectionId: optionalText(raw.parentCollectionId),
    childCollectionIds: textArray(raw.childCollectionIds, 'Legacy child folders'),
    memberObjectIds: textArray(raw.memberObjectIds, 'Legacy folder members'),
    excludedChildren: array(raw.excludedChildFolders, 'Excluded folders must be an array.').map(
      (entry, index) => {
        const child = record(entry, `Excluded folder ${index + 1} must be an object.`);
        return {
          id: requiredText(child.sourceFolderId, `Excluded folder ${index + 1} ID`),
          name: requiredText(child.name, `Excluded folder ${index + 1} name`),
        };
      }
    ),
    sourceUrl: optionalText(provenance?.sourceUrl),
  };
}

const TIPTAP_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'codeBlock',
  'tableRow',
]);

function collectTipTapSegments(
  value: unknown,
  output: ScientificRichTextSegment[],
  root = false
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const node = value as JsonRecord;
  if (node.type === 'text' && typeof node.text === 'string') {
    output.push({ text: node.text, link: linkFromTipTapMarks(node.marks) });
    return;
  }
  if (node.type === 'hardBreak') {
    output.push({ text: '\n', link: null });
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectTipTapSegments(child, output);
  }
  if (!root && typeof node.type === 'string' && TIPTAP_BLOCK_TYPES.has(node.type)) {
    output.push({ text: '\n', link: null });
  }
}

function linkFromTipTapMarks(value: unknown): ScientificDocumentLink | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const mark = optionalRecord(entry);
    if (mark?.type !== 'link') continue;
    const attrs = optionalRecord(mark.attrs);
    const href = optionalText(attrs?.href);
    if (!href) return null;
    const nativeEntityId = nativeEntityReferenceIdFromHref(href);
    if (nativeEntityId) {
      return { kind: 'local', href, destinationTargetId: nativeEntityId };
    }
    if (href.startsWith('entity://migration/')) {
      const encodedTarget = href.slice('entity://migration/'.length);
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(encodedTarget);
      } catch {
        return null;
      }
      const destinationTargetId = optionalText(attrs?.destinationTargetId) ?? decodedTarget;
      if (!destinationTargetId || /[\0\r\n]/.test(destinationTargetId)) return null;
      return { kind: 'local', href, destinationTargetId };
    }
    const safeHref = safeExternalHttpUrl(href);
    if (safeHref) return { kind: 'external', href: safeHref };
  }
  return null;
}

function mergeRichTextSegments(values: ScientificRichTextSegment[]): ScientificRichTextSegment[] {
  const merged: ScientificRichTextSegment[] = [];
  for (const value of values) {
    if (!value.text) continue;
    const prior = merged[merged.length - 1];
    if (prior && sameDocumentLink(prior.link, value.link)) {
      prior.text += value.text;
    } else {
      merged.push({ text: value.text, link: value.link });
    }
  }
  while (merged[0]?.text && /^\s*$/.test(merged[0].text)) merged.shift();
  let trailing = merged[merged.length - 1];
  while (trailing?.text && /^\s*$/.test(trailing.text)) {
    merged.pop();
    trailing = merged[merged.length - 1];
  }
  if (merged[0]) merged[0].text = merged[0].text.replace(/^\s+/, '');
  const last = merged[merged.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, '');
  return merged.filter((value) => value.text.length > 0);
}

function sameDocumentLink(
  left: ScientificDocumentLink | null,
  right: ScientificDocumentLink | null
): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.href !== right.href) return false;
  return (
    left.kind === 'external' ||
    (right.kind === 'local' && left.destinationTargetId === right.destinationTargetId)
  );
}

function plainTextTipTapDocument(value: string): JsonRecord {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('Protocol content must be text.');
  }
  return {
    type: 'doc',
    content: value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : [],
      })),
  };
}

function normalizeStepOrdinals(steps: JsonRecord[]): JsonRecord[] {
  return steps.map((step, index) => ({ ...step, ordinal: index + 1 }));
}

function fileName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function singleLine(value: string): string {
  return value
    .replace(/[\0\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must be single-line text.`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (value.includes('\0')) throw new Error(`${label} contains an invalid null character.`);
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredText(value, 'Collection reference');
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function normalizedCoordinate(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed < 0 || parsed > 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function normalizedExtent(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0 || parsed > 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function sha256Digest(value: unknown, label: string): string {
  const digest = requiredText(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} is invalid.`);
  return digest;
}

function record(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function array(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function textArray(value: unknown, label: string): string[] {
  return array(value, `${label} must be an array.`).map((entry, index) =>
    requiredText(entry, `${label} ${index + 1}`)
  );
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
