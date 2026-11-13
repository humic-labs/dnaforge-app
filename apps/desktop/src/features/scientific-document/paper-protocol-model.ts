type JsonRecord = Record<string, unknown>;

export type PaperProtocolCandidateStatus = 'proposed' | 'selected' | 'rejected';
export type PaperProtocolDraftState = 'draft' | 'finalized';
export type PaperProtocolEvidenceClass =
  | 'direct'
  | 'resolved_reference'
  | 'agent_inference'
  | 'user_edit';

type PaperProtocolSourceBase = {
  sourceId: string;
  title: string;
  mediaType: string;
  sha256: string;
  capturedAt: string;
};

export type PaperProtocolPdfExtraction = {
  name: string;
  version: string;
  mode: string;
  configuration: string;
};

export type PaperProtocolPdfSource = PaperProtocolSourceBase & {
  kind: 'pdf';
  workspacePath: string;
  pageCount: number;
  extraction?: PaperProtocolPdfExtraction;
  originalUrl?: string;
  canonicalUrl?: string;
};

export type PaperProtocolCapturedTextSource = PaperProtocolSourceBase & {
  kind: 'captured_text';
  originalUrl: string;
  canonicalUrl: string;
  text: string;
};

export type PaperProtocolSource = PaperProtocolPdfSource | PaperProtocolCapturedTextSource;

export type PaperProtocolPdfLocator = {
  kind: 'pdf_rects';
  page: number;
  rects: Array<{ x: number; y: number; width: number; height: number }>;
};

export type PaperProtocolTextLocator = {
  kind: 'text_span';
  start: number;
  end: number;
};

export type PaperProtocolEvidence = {
  evidenceId: string;
  stepId: string;
  sourceId: string;
  sourceSha256: string;
  evidenceClass: PaperProtocolEvidenceClass;
  quote: string;
  locator: PaperProtocolPdfLocator | PaperProtocolTextLocator;
};

export type PaperProtocolGap = {
  gapId: string;
  stepId: string;
  missing: string;
  attemptedResolution: string[];
};

export type PaperProtocolAcceptedVersion = {
  acceptedVersionId: string;
  draftRevision: number;
  contentHash: string;
  sourceHashes: string[];
  finalizedAt: string;
  finalizedBy: 'user';
  idempotencyKeyHash: string;
  previewFingerprint: string;
  payload: JsonRecord;
};

export type PaperProtocolWorkflow = {
  schema: 'dnaforge.paper-protocol.v1';
  candidate: {
    candidateSetId: string;
    candidateId: string;
    ordinal: number;
    label: string;
    status: PaperProtocolCandidateStatus;
  };
  draft: {
    revision: number;
    state: PaperProtocolDraftState;
    reopenedFromAcceptedVersionId: string | null;
    reopenIdempotencyKeyHash: string | null;
  };
  sources: PaperProtocolSource[];
  evidence: PaperProtocolEvidence[];
  gaps: PaperProtocolGap[];
  acceptedVersions: PaperProtocolAcceptedVersion[];
};

export type FinalizePaperProtocolResult = {
  raw: JsonRecord;
  acceptedVersion: PaperProtocolAcceptedVersion;
  replayed: boolean;
};

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parsePaperProtocolWorkflow(
  value: unknown,
  protocolStepIds: readonly string[]
): PaperProtocolWorkflow {
  const raw = record(value, 'Paper protocol workflow must be an object.');
  if (raw.schema !== 'dnaforge.paper-protocol.v1') {
    throw new Error('Paper protocol workflow schema must be dnaforge.paper-protocol.v1.');
  }

  const stepIds = new Set(protocolStepIds);
  if (stepIds.size !== protocolStepIds.length) {
    throw new Error('Protocol step IDs must be unique before evidence can be validated.');
  }

  const candidateRaw = record(raw.candidate, 'Paper protocol candidate must be an object.');
  const candidate = {
    candidateSetId: requiredText(candidateRaw.candidateSetId, 'Candidate set ID'),
    candidateId: requiredText(candidateRaw.candidateId, 'Candidate ID'),
    ordinal: positiveInteger(candidateRaw.ordinal, 'Candidate ordinal'),
    label: requiredText(candidateRaw.label, 'Candidate label'),
    status: candidateStatus(candidateRaw.status),
  };

  const draftRaw = record(raw.draft, 'Paper protocol draft must be an object.');
  const draft = {
    revision: positiveInteger(draftRaw.revision, 'Draft revision'),
    state: draftState(draftRaw.state),
    reopenedFromAcceptedVersionId: nullableText(
      draftRaw.reopenedFromAcceptedVersionId,
      'Reopened accepted version ID'
    ),
    reopenIdempotencyKeyHash:
      draftRaw.reopenIdempotencyKeyHash === undefined
        ? null
        : nullableSha256(draftRaw.reopenIdempotencyKeyHash, 'Reopen idempotency key hash'),
  };

  const sources = array(raw.sources, 'Paper protocol sources').map(parseSource);
  assertUnique(
    sources.map((source) => source.sourceId),
    'Paper protocol source IDs must be unique.'
  );
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));

  const evidence = array(raw.evidence, 'Paper protocol evidence').map((entry) =>
    parseEvidence(entry, stepIds, sourceById)
  );
  assertUnique(
    evidence.map((entry) => entry.evidenceId),
    'Paper protocol evidence IDs must be unique.'
  );

  const gaps = array(raw.gaps, 'Paper protocol gaps').map((entry) => parseGap(entry, stepIds));
  assertUnique(
    gaps.map((gap) => gap.gapId),
    'Paper protocol gap IDs must be unique.'
  );

  const acceptedVersions = array(raw.acceptedVersions, 'Accepted paper protocol versions').map(
    parseAcceptedVersion
  );
  assertUnique(
    acceptedVersions.map((version) => version.acceptedVersionId),
    'Accepted paper protocol version IDs must be unique.'
  );
  for (let index = 1; index < acceptedVersions.length; index += 1) {
    if (acceptedVersions[index].draftRevision <= acceptedVersions[index - 1].draftRevision) {
      throw new Error('Accepted revisions must increase in append-only order.');
    }
  }

  const sourceHashes = new Set(sources.map((source) => source.sha256));
  for (const version of acceptedVersions) {
    assertUnique(version.sourceHashes, 'Accepted version source hashes must be unique.');
    for (const hash of version.sourceHashes) {
      if (!sourceHashes.has(hash)) {
        throw new Error('Accepted version refers to an unknown source hash.');
      }
    }
  }

  if (draft.state === 'finalized') {
    const latest = acceptedVersions[acceptedVersions.length - 1];
    if (!latest || latest.draftRevision !== draft.revision) {
      throw new Error('A finalized draft must have an accepted version for its current revision.');
    }
  }

  if (
    draft.reopenedFromAcceptedVersionId !== null &&
    !acceptedVersions.some(
      (version) => version.acceptedVersionId === draft.reopenedFromAcceptedVersionId
    )
  ) {
    throw new Error('Reopened draft refers to an unknown accepted version.');
  }

  return {
    schema: 'dnaforge.paper-protocol.v1',
    candidate,
    draft,
    sources,
    evidence,
    gaps,
    acceptedVersions,
  };
}

export function canonicalPaperProtocolReviewPayload(protocol: JsonRecord): string {
  const reviewPayload = cloneJsonRecord(protocol);
  const workflow = optionalRecord(reviewPayload.paperProtocol);
  if (workflow) {
    const withoutHistory = cloneJsonRecord(workflow);
    delete withoutHistory.acceptedVersions;
    const draft = optionalRecord(withoutHistory.draft);
    if (draft) {
      draft.state = 'draft';
      delete draft.reopenIdempotencyKeyHash;
    }
    reviewPayload.paperProtocol = withoutHistory;
  }
  return stableStringify(reviewPayload);
}

export function selectPaperProtocolCandidateWorkflow(
  protocol: JsonRecord,
  input: { expectedCandidateId: string; expectedRevision: number }
): { raw: JsonRecord; replayed: boolean; draftRevision: number } {
  const raw = cloneJsonRecord(protocol);
  const workflow = parseWorkflowFromProtocol(raw);
  const expectedCandidateId = requiredText(input.expectedCandidateId, 'Expected candidate ID');
  if (workflow.candidate.candidateId !== expectedCandidateId) {
    throw new Error('Paper protocol candidate identity changed before selection.');
  }
  if (workflow.draft.revision !== input.expectedRevision) {
    throw new Error(
      `Paper protocol draft revision changed: expected ${input.expectedRevision}, found ${workflow.draft.revision}.`
    );
  }
  if (workflow.draft.state !== 'draft') {
    throw new Error('A finalized paper protocol cannot be selected as a new candidate.');
  }
  if (workflow.candidate.status === 'selected') {
    return { raw, replayed: true, draftRevision: workflow.draft.revision };
  }
  if (workflow.candidate.status !== 'proposed') {
    throw new Error('Only a proposed paper protocol candidate can be selected.');
  }

  const workflowRaw = cloneJsonRecord(
    record(raw.paperProtocol, 'Paper protocol workflow must be an object.')
  );
  workflowRaw.candidate = {
    ...workflow.candidate,
    status: 'selected',
  };
  workflowRaw.draft = {
    ...workflow.draft,
    revision: workflow.draft.revision + 1,
  };
  raw.paperProtocol = workflowRaw;
  parseWorkflowFromProtocol(raw);
  return { raw, replayed: false, draftRevision: workflow.draft.revision + 1 };
}

export async function finalizePaperProtocolWorkflow(
  protocol: JsonRecord,
  input: {
    expectedRevision: number;
    finalizedAt: string;
    idempotencyKey: string;
    previewFingerprint: string;
  }
): Promise<FinalizePaperProtocolResult> {
  const raw = cloneJsonRecord(protocol);
  const workflow = parseWorkflowFromProtocol(raw);
  if (workflow.candidate.status !== 'selected') {
    throw new Error('Only a user-selected paper protocol candidate can be finalized.');
  }
  if (workflow.draft.revision !== input.expectedRevision) {
    throw new Error(
      `Paper protocol draft revision changed: expected ${input.expectedRevision}, found ${workflow.draft.revision}.`
    );
  }
  const finalizedAt = timestamp(input.finalizedAt, 'Paper protocol finalization time');
  const idempotencyKey = requiredText(input.idempotencyKey, 'Finalization idempotency key');
  if (idempotencyKey.length > 200) {
    throw new Error('Finalization idempotency key must be at most 200 characters.');
  }
  const previewFingerprint = sha256(input.previewFingerprint, 'Finalization preview fingerprint');
  const canonical = canonicalPaperProtocolReviewPayload(raw);
  const contentHash = await sha256PaperProtocolPayload(canonical);
  const idempotencyKeyHash = await sha256PaperProtocolPayload(idempotencyKey);

  if (workflow.draft.state === 'finalized') {
    const accepted = workflow.acceptedVersions.find(
      (version) =>
        version.draftRevision === workflow.draft.revision && version.contentHash === contentHash
    );
    if (!accepted) {
      throw new Error('Finalized paper protocol does not match its accepted content snapshot.');
    }
    if (
      accepted.idempotencyKeyHash !== idempotencyKeyHash ||
      accepted.previewFingerprint !== previewFingerprint
    ) {
      throw new Error('Finalization idempotency key was reused for a different intent.');
    }
    return { raw, acceptedVersion: accepted, replayed: true };
  }

  const acceptedVersion: PaperProtocolAcceptedVersion = {
    acceptedVersionId: `accepted-${contentHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    draftRevision: workflow.draft.revision,
    contentHash,
    sourceHashes: [...new Set(workflow.sources.map((source) => source.sha256))].sort(),
    finalizedAt,
    finalizedBy: 'user',
    idempotencyKeyHash,
    previewFingerprint,
    payload: JSON.parse(canonical) as JsonRecord,
  };
  const workflowRaw = cloneJsonRecord(
    record(raw.paperProtocol, 'Paper protocol workflow must be an object.')
  );
  workflowRaw.draft = {
    revision: workflow.draft.revision,
    state: 'finalized',
    reopenedFromAcceptedVersionId: workflow.draft.reopenedFromAcceptedVersionId,
    reopenIdempotencyKeyHash: workflow.draft.reopenIdempotencyKeyHash,
  };
  workflowRaw.acceptedVersions = [...workflow.acceptedVersions, acceptedVersion];
  raw.paperProtocol = workflowRaw;
  parseWorkflowFromProtocol(raw);
  return { raw, acceptedVersion, replayed: false };
}

export async function reopenPaperProtocolWorkflow(
  protocol: JsonRecord,
  input: { acceptedVersionId: string; idempotencyKey: string }
): Promise<{ raw: JsonRecord; replayed: boolean; draftRevision: number }> {
  const raw = cloneJsonRecord(protocol);
  const workflow = parseWorkflowFromProtocol(raw);
  const acceptedVersionId = requiredText(input.acceptedVersionId, 'Accepted version ID');
  const idempotencyKey = requiredText(input.idempotencyKey, 'Reopen idempotency key');
  if (idempotencyKey.length > 200) {
    throw new Error('Reopen idempotency key must be at most 200 characters.');
  }
  const idempotencyKeyHash = await sha256PaperProtocolPayload(idempotencyKey);
  const accepted = workflow.acceptedVersions.find(
    (version) => version.acceptedVersionId === acceptedVersionId
  );
  if (!accepted) throw new Error('Accepted paper protocol version was not found.');
  if (
    workflow.draft.state === 'draft' &&
    workflow.draft.reopenedFromAcceptedVersionId === acceptedVersionId &&
    workflow.draft.reopenIdempotencyKeyHash === idempotencyKeyHash &&
    workflow.draft.revision === accepted.draftRevision + 1
  ) {
    return { raw, replayed: true, draftRevision: workflow.draft.revision };
  }
  if (workflow.draft.state !== 'finalized') {
    throw new Error('Only a finalized paper protocol can be reopened.');
  }
  const latest = workflow.acceptedVersions[workflow.acceptedVersions.length - 1];
  if (
    !latest ||
    latest.acceptedVersionId !== acceptedVersionId ||
    latest.draftRevision !== workflow.draft.revision
  ) {
    throw new Error('Finalized paper protocol has no current accepted version to reopen.');
  }
  const workflowRaw = cloneJsonRecord(
    record(raw.paperProtocol, 'Paper protocol workflow must be an object.')
  );
  workflowRaw.draft = {
    revision: workflow.draft.revision + 1,
    state: 'draft',
    reopenedFromAcceptedVersionId: latest.acceptedVersionId,
    reopenIdempotencyKeyHash: idempotencyKeyHash,
  };
  raw.paperProtocol = workflowRaw;
  parseWorkflowFromProtocol(raw);
  return { raw, replayed: false, draftRevision: workflow.draft.revision + 1 };
}

export async function sha256PaperProtocolPayload(value: unknown): Promise<string> {
  const canonical = typeof value === 'string' ? value : stableStringify(value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

export async function validatePaperProtocolSourceHashes(
  workflow: PaperProtocolWorkflow
): Promise<void> {
  for (const source of workflow.sources) {
    if (source.kind !== 'captured_text') continue;
    const actual = await sha256PaperProtocolPayload(source.text);
    if (actual !== source.sha256) {
      throw new Error(`Captured text hash does not match source ${source.sourceId}.`);
    }
  }
}

function parseSource(value: unknown): PaperProtocolSource {
  const raw = record(value, 'Paper protocol source must be an object.');
  const common = {
    sourceId: requiredText(raw.sourceId, 'Source ID'),
    title: requiredText(raw.title, 'Source title'),
    mediaType: requiredText(raw.mediaType, 'Source media type'),
    sha256: sha256(raw.sha256, 'Source SHA-256'),
    capturedAt: timestamp(raw.capturedAt, 'Source capture time'),
  };

  if (raw.kind === 'pdf') {
    if (common.mediaType !== 'application/pdf') {
      throw new Error('PDF source media type must be application/pdf.');
    }
    const hasOriginalUrl = raw.originalUrl !== undefined;
    const hasCanonicalUrl = raw.canonicalUrl !== undefined;
    if (hasOriginalUrl !== hasCanonicalUrl) {
      throw new Error('Remote PDF provenance requires both original and canonical URLs.');
    }
    return {
      ...common,
      kind: 'pdf',
      workspacePath: relativeWorkspacePath(raw.workspacePath),
      pageCount: positiveInteger(raw.pageCount, 'PDF page count'),
      ...(raw.extraction === undefined ? {} : { extraction: parsePdfExtraction(raw.extraction) }),
      ...(hasOriginalUrl
        ? {
            originalUrl: safeHttpUrl(raw.originalUrl, 'Original source URL'),
            canonicalUrl: safeHttpUrl(raw.canonicalUrl, 'Canonical source URL'),
          }
        : {}),
    };
  }
  if (raw.kind === 'captured_text') {
    return {
      ...common,
      kind: 'captured_text',
      originalUrl: safeHttpUrl(raw.originalUrl, 'Original source URL'),
      canonicalUrl: safeHttpUrl(raw.canonicalUrl, 'Canonical source URL'),
      text: requiredString(raw.text, 'Captured source text'),
    };
  }
  throw new Error('Paper protocol source kind must be pdf or captured_text.');
}

function parsePdfExtraction(value: unknown): PaperProtocolPdfExtraction {
  const raw = record(value, 'PDF extraction metadata must be an object.');
  return {
    name: requiredText(raw.name, 'PDF extraction parser name'),
    version: requiredText(raw.version, 'PDF extraction parser version'),
    mode: requiredText(raw.mode, 'PDF extraction mode'),
    configuration: requiredText(raw.configuration, 'PDF extraction configuration'),
  };
}

function parseWorkflowFromProtocol(protocol: JsonRecord): PaperProtocolWorkflow {
  const steps = array(protocol.steps, 'Protocol steps').map((entry, index) =>
    requiredText(
      record(entry, `Protocol step ${index + 1} must be an object.`).id,
      `Protocol step ${index + 1} ID`
    )
  );
  return parsePaperProtocolWorkflow(protocol.paperProtocol, steps);
}

function parseEvidence(
  value: unknown,
  stepIds: ReadonlySet<string>,
  sourceById: ReadonlyMap<string, PaperProtocolSource>
): PaperProtocolEvidence {
  const raw = record(value, 'Paper protocol evidence must be an object.');
  const evidenceId = requiredText(raw.evidenceId, 'Evidence ID');
  const stepId = requiredText(raw.stepId, 'Evidence step ID');
  if (!stepIds.has(stepId)) {
    throw new Error(`Evidence ${evidenceId} refers to an unknown protocol step.`);
  }
  const sourceId = requiredText(raw.sourceId, 'Evidence source ID');
  const source = sourceById.get(sourceId);
  if (!source) throw new Error(`Evidence ${evidenceId} refers to an unknown source.`);
  const sourceSha256 = sha256(raw.sourceSha256, 'Evidence source SHA-256');
  if (sourceSha256 !== source.sha256) {
    throw new Error(`Evidence ${evidenceId} source hash does not match its source.`);
  }
  const quote = requiredString(raw.quote, 'Evidence quote');
  const locatorRaw = record(raw.locator, 'Evidence locator must be an object.');
  const locator =
    source.kind === 'pdf'
      ? parsePdfLocator(locatorRaw, source)
      : parseTextLocator(locatorRaw, source, quote);
  return {
    evidenceId,
    stepId,
    sourceId,
    sourceSha256,
    evidenceClass: evidenceClass(raw.evidenceClass),
    quote,
    locator,
  };
}

function parsePdfLocator(raw: JsonRecord, source: PaperProtocolPdfSource): PaperProtocolPdfLocator {
  if (raw.kind !== 'pdf_rects') {
    throw new Error('PDF source requires PDF rectangle evidence.');
  }
  const page = positiveInteger(raw.page, 'Evidence PDF page');
  if (page > source.pageCount) throw new Error('Evidence PDF page exceeds the source page count.');
  const rects = array(raw.rects, 'Evidence PDF rectangles').map((value) => {
    const rect = record(value, 'Evidence PDF rectangle must be an object.');
    const parsed = {
      x: normalizedNumber(rect.x, 'Evidence rectangle x'),
      y: normalizedNumber(rect.y, 'Evidence rectangle y'),
      width: positiveNormalizedNumber(rect.width, 'Evidence rectangle width'),
      height: positiveNormalizedNumber(rect.height, 'Evidence rectangle height'),
    };
    if (parsed.x + parsed.width > 1 || parsed.y + parsed.height > 1) {
      throw new Error('Evidence PDF rectangle must fit within its normalized page.');
    }
    return parsed;
  });
  if (rects.length === 0) throw new Error('PDF evidence must include at least one rectangle.');
  return { kind: 'pdf_rects', page, rects };
}

function parseTextLocator(
  raw: JsonRecord,
  source: PaperProtocolCapturedTextSource,
  quote: string
): PaperProtocolTextLocator {
  if (raw.kind !== 'text_span') {
    throw new Error('Captured text source requires text span evidence.');
  }
  const start = nonNegativeInteger(raw.start, 'Evidence text start');
  const end = positiveInteger(raw.end, 'Evidence text end');
  if (end <= start || end > source.text.length) {
    throw new Error('Evidence text span is outside the captured source.');
  }
  if (source.text.slice(start, end) !== quote) {
    throw new Error('Evidence quote does not match the captured source text.');
  }
  return { kind: 'text_span', start, end };
}

function parseGap(value: unknown, stepIds: ReadonlySet<string>): PaperProtocolGap {
  const raw = record(value, 'Paper protocol evidence gap must be an object.');
  const stepId = requiredText(raw.stepId, 'Evidence gap step ID');
  if (!stepIds.has(stepId)) throw new Error('Evidence gap refers to an unknown protocol step.');
  return {
    gapId: requiredText(raw.gapId, 'Evidence gap ID'),
    stepId,
    missing: requiredText(raw.missing, 'Missing evidence description'),
    attemptedResolution: array(raw.attemptedResolution, 'Attempted evidence resolution').map(
      (entry) => requiredText(entry, 'Attempted evidence resolution entry')
    ),
  };
}

function parseAcceptedVersion(value: unknown): PaperProtocolAcceptedVersion {
  const raw = record(value, 'Accepted paper protocol version must be an object.');
  if (raw.finalizedBy !== 'user') {
    throw new Error('Accepted paper protocol versions must be finalized by the user.');
  }
  return {
    acceptedVersionId: requiredText(raw.acceptedVersionId, 'Accepted version ID'),
    draftRevision: positiveInteger(raw.draftRevision, 'Accepted draft revision'),
    contentHash: sha256(raw.contentHash, 'Accepted content hash'),
    sourceHashes: array(raw.sourceHashes, 'Accepted source hashes').map((entry) =>
      sha256(entry, 'Accepted source hash')
    ),
    finalizedAt: timestamp(raw.finalizedAt, 'Accepted finalization time'),
    finalizedBy: 'user',
    idempotencyKeyHash: sha256(raw.idempotencyKeyHash, 'Accepted idempotency key hash'),
    previewFingerprint: sha256(raw.previewFingerprint, 'Accepted preview fingerprint'),
    payload: cloneJsonRecord(record(raw.payload, 'Accepted payload must be an object.')),
  };
}

function candidateStatus(value: unknown): PaperProtocolCandidateStatus {
  if (value === 'proposed' || value === 'selected' || value === 'rejected') return value;
  throw new Error('Candidate status must be proposed, selected, or rejected.');
}

function draftState(value: unknown): PaperProtocolDraftState {
  if (value === 'draft' || value === 'finalized') return value;
  throw new Error('Draft state must be draft or finalized.');
}

function evidenceClass(value: unknown): PaperProtocolEvidenceClass {
  if (
    value === 'direct' ||
    value === 'resolved_reference' ||
    value === 'agent_inference' ||
    value === 'user_edit'
  ) {
    return value;
  }
  throw new Error('Evidence class is invalid.');
}

function record(value: unknown, message: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  const text = requiredString(value, label).trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredText(value, label);
}

function nullableSha256(value: unknown, label: string): string | null {
  if (value === null) return null;
  return sha256(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function normalizedNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
  return value;
}

function positiveNormalizedNumber(value: unknown, label: string): number {
  const parsed = normalizedNumber(value, label);
  if (parsed === 0) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = requiredText(value, label);
  if (!SHA256_PATTERN.test(parsed)) throw new Error(`${label} must be a SHA-256 identity.`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = requiredText(value, label);
  if (!Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString() !== parsed) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return parsed;
}

function safeHttpUrl(value: unknown, label: string): string {
  const parsed = requiredText(value, label);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${label} must be an absolute HTTP URL.`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`${label} must be a credential-free HTTP URL.`);
  }
  return url.href;
}

function relativeWorkspacePath(value: unknown): string {
  const parsed = requiredText(value, 'PDF project path').replace(/\\/g, '/');
  if (
    parsed.startsWith('/') ||
    parsed.split('/').some((part: string) => part === '..' || part === '')
  ) {
    throw new Error('PDF project path must be a safe relative path.');
  }
  return parsed;
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Canonical review payload cannot contain non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value === 'object') {
    const raw = value as JsonRecord;
    return Object.fromEntries(
      Object.keys(raw)
        .sort()
        .map((key) => [key, sortJsonValue(raw[key])])
    );
  }
  throw new Error('Canonical review payload contains an unsupported value.');
}
