import { createHash } from 'node:crypto';
import {
  isCatalogRecordPresentationKind,
  type CatalogRecordPresentationKind,
} from '../../shared/catalog-entity';
import path from 'node:path';
import {
  applyComplementOriginWrap,
  parseGenBankFull,
  parseFeatureLocation,
  serializeGenBank,
  type AnnotatedSequence,
  type Annotation,
  type AnnotationDirection,
} from '@waypoint/sequence-utils';
import {
  buildNotebookPackageMetadata,
  notebookPackagePaths,
  serializeNotebookPackageMetadata,
  type NotebookPackageDocument,
} from '../../db/notebook-package';
import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { NotebookDocumentModel } from '../../shared/notebook-model/document';
import type {
  CatalogProjectionPayload,
  NativeRepresentation,
  ProjectionDestination,
  ProjectionFormulaEvidence,
  ProjectionKind,
  SourceObject,
} from '../../shared/benchling-migration';
import { MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES } from '../../shared/benchling-notebook-source';
import { buildPreservedMigrationRawSourceUri } from '../../shared/benchling-migration-raw-source';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import { SUPPORTED_TABLE_FORMULAS } from '../../shared/table-formulas';
import {
  PROTOCOL_PACKAGE_META_NAME,
  PROTOCOL_RUN_PACKAGE_META_NAME,
} from '../../shared/scientific-package';
import { collectProjectionFormulaEvidence } from './formula-evidence';
import {
  buildNotebookHtmlProjection,
  type NotebookAttachmentBinding,
  type NotebookLocalLinkBinding,
} from './notebook-html-projection';
import { buildProtocolProjection, type ProtocolProjectionLinkInput } from './protocol-projection';
import { buildProtocolRunProjection } from './protocol-run-projection';
import type { OutboundLinkSet } from './relationship-link-map';
import { nativeSequenceSourceEvidence } from './native-sequence-source-evidence';
import { providerIdentityDestinationObjectId } from './native-record-classifier';
import { isBenchlingLocalExportProvenanceUrn } from './source-identity';

const IMPORT_ROOT = 'Benchling Imports';
const NOTEBOOK_PACKAGE_STEM_MAX_LENGTH = 58;
const NOTEBOOK_PROVENANCE_FIELD_MAX_BYTES = 1_536;
const PREVIEW_LIMIT = 2_000;
const DNA_ALPHABET = /^[ACGTRYSWKMBDHVN]+$/i;
const RNA_ALPHABET = /^[ACGURYSWKMBDHVN]+$/i;
const PROTEIN_ALPHABET = /^[ACDEFGHIKLMNPQRSTVWY]+$/i;
const SAFE_FEATURE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,14}$/;
const SAFE_QUALIFIER_KEY = /^\w+$/;
const COMPOUND_LOCATION_SEGMENT = String.raw`\d+\.\.\d+`;
const FORWARD_JOIN_LOCATION = new RegExp(
  `^join\\(${COMPOUND_LOCATION_SEGMENT}(?:,${COMPOUND_LOCATION_SEGMENT})+\\)$`
);
const REVERSE_JOIN_LOCATION = new RegExp(
  `^complement\\(join\\(${COMPOUND_LOCATION_SEGMENT}(?:,${COMPOUND_LOCATION_SEGMENT})+\\)\\)$`
);
const BENCHLING_NATIVE_RECORD_PACKAGE_META_NAME = 'benchling-native-record.json' as const;

export type ProjectionFile =
  | { relativePath: string; text: string; bytes?: never }
  | { relativePath: string; bytes: Uint8Array; text?: never };

export function validateProjectionDestination(value: unknown): ProjectionDestination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Projection destination must be an object.');
  }
  const destination = value as Record<string, unknown>;
  if (destination.kind === 'file') {
    assertProjectionDestinationKeys(destination, ['kind', 'relativePath']);
    return {
      kind: 'file',
      relativePath: projectionDestinationPath(destination.relativePath, 'file path'),
    };
  }
  if (destination.kind === 'package') {
    assertProjectionDestinationKeys(destination, [
      'kind',
      'rootRelativePath',
      'primaryRelativePath',
    ]);
    const rootRelativePath = projectionDestinationPath(
      destination.rootRelativePath,
      'package root'
    );
    const primaryRelativePath = projectionDestinationPath(
      destination.primaryRelativePath,
      'package primary path'
    );
    if (!primaryRelativePath.startsWith(`${rootRelativePath}/`)) {
      throw new Error('Projection primary path must be inside its package root.');
    }
    return { kind: 'package', rootRelativePath, primaryRelativePath };
  }
  if (destination.kind === 'catalog-record') {
    assertProjectionDestinationKeys(destination, [
      'kind',
      'parentRelativePath',
      'displayName',
      'catalogType',
      'presentationKind',
    ]);
    const parentRelativePath =
      destination.parentRelativePath === ''
        ? ''
        : projectionDestinationPath(destination.parentRelativePath, 'catalog parent path');
    if (
      typeof destination.displayName !== 'string' ||
      !destination.displayName.trim() ||
      typeof destination.catalogType !== 'string' ||
      !destination.catalogType.trim() ||
      !isCatalogRecordPresentationKind(destination.presentationKind)
    ) {
      throw new Error('Projection catalog-record destination is invalid.');
    }
    return {
      kind: 'catalog-record',
      parentRelativePath,
      displayName: destination.displayName.trim(),
      catalogType: destination.catalogType.trim(),
      presentationKind: destination.presentationKind,
    };
  }
  throw new Error('Projection destination kind is unsupported.');
}

function projectionDestinationPath(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Projection ${label} is invalid.`);
  const normalized = value.replace(/\\/g, '/');
  if (!isSafeWorkspaceRelativePath(normalized)) {
    throw new Error(`Projection ${label} is unsafe.`);
  }
  const topLevel = normalized.split('/')[0]?.normalize('NFC').toLowerCase();
  if (topLevel && ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel)) {
    throw new Error(`Projection ${label} uses a protected root.`);
  }
  return normalized;
}

function assertProjectionDestinationKeys(
  destination: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(destination).some((key) => !allowedKeys.has(key))) {
    throw new Error('Projection destination mixes fields from different destination kinds.');
  }
}

export type ProjectionPlan = {
  files: ProjectionFile[];
  attachmentAssets?: Array<{
    relativePath: string;
    archiveSha256: string;
  }>;
  projection: ProjectionKind;
  nativeRepresentation: NativeRepresentation | null;
  destinationObjectId: string;
  destination: ProjectionDestination;
  catalogPayload?: CatalogProjectionPayload;
  sourceHash: string;
  destinationHash: string;
  warnings: string[];
  exception: string | null;
  formulaEvidence: ProjectionFormulaEvidence[];
  converterId: string;
  converterVersion: string;
};

export type ProjectionPlanOptions = {
  runId: string;
  capturedAt: string;
  converterVersion: string;
  links?: OutboundLinkSet;
  destination?: ProjectionDestination;
  destinationEntityId?: string;
  destinationDirectory?: string;
};

type NativeProjection = {
  converterId: string;
  extension?: '.gb' | '.faa';
  packageMetaName?:
    | typeof PROTOCOL_PACKAGE_META_NAME
    | typeof PROTOCOL_RUN_PACKAGE_META_NAME
    | typeof BENCHLING_NATIVE_RECORD_PACKAGE_META_NAME;
  text: string;
  warnings: string[];
  destinationObjectId?: string;
  notebookDocument?: NotebookPackageDocument;
  benchlingEntryMetadata?: Record<string, unknown> | null;
  attachmentAssets?: Array<{ relativePath: string; archiveSha256: string }>;
};

type NativeProjectionOptions = ProjectionPlanOptions & { notebookPackageRoot: string };

export function buildProjectionPlan(
  sourceObject: SourceObject,
  options: ProjectionPlanOptions
): ProjectionPlan {
  const sourceHash = projectionSourceHash(sourceObject);
  const baseName = projectionBaseName(sourceObject);
  const allocatedDestination = options.destination
    ? validateProjectionDestination(options.destination)
    : null;
  const directory = allocatedDestination
    ? projectionDestinationDirectory(allocatedDestination)
    : projectionDirectory(baseName, options.destinationDirectory);
  const fallbackDestinationObjectId = projectionDestinationObjectId(sourceObject);

  let native: NativeProjection | null = null;
  let exception: string | null = null;
  try {
    native = buildNativeProjection(sourceObject, {
      ...options,
      destinationEntityId:
        options.destinationEntityId ??
        (allocatedDestination ? fallbackDestinationObjectId : undefined),
      notebookPackageRoot: directory,
    });
  } catch (error) {
    exception = error instanceof Error ? error.message : 'Native conversion failed.';
  }

  const projection: ProjectionKind = native ? 'native' : 'fallback';
  const nativeRepresentation = native ? nativeRepresentationFor(sourceObject) : null;
  const destinationObjectId =
    options.destinationEntityId ?? native?.destinationObjectId ?? fallbackDestinationObjectId;
  const converterId = native?.converterId ?? 'benchling-artifact-card';
  const warnings = native?.warnings ?? [`Native conversion exception: ${exception}`];
  const formulaEvidence = collectProjectionFormulaEvidence(sourceObject);
  const primaryExtension = native?.extension ?? '.md';
  const notebookPackageRoot = native?.notebookDocument ? directory : null;
  const legacyPrimaryPath = notebookPackageRoot
    ? `${notebookPackageRoot}/.forge/notebook.json`
    : native?.packageMetaName
      ? `${directory}/.forge/${native.packageMetaName}`
      : `${directory}/${baseName}${primaryExtension}`;
  const destination: ProjectionDestination =
    allocatedDestination ??
    ({
      kind: 'package',
      rootRelativePath: directory,
      primaryRelativePath: legacyPrimaryPath,
    } as const);
  const destinationPath = projectionDestinationPrimaryPath(destination);
  let primaryText =
    native?.text ?? buildArtifactCard(sourceObject, exception ?? 'Unsupported source object.');
  const provenancePath = `${directory}/${baseName}.benchling-provenance.json`;
  const provenanceText = buildProvenance(sourceObject, options, {
    sourceHash,
    converterId,
    projection,
    nativeRepresentation,
    destinationObjectId,
    benchlingEntryMetadata: native?.benchlingEntryMetadata,
  });
  const files: ProjectionFile[] = [];
  if (!(destination.kind === 'catalog-record')) {
    if (notebookPackageRoot && native?.notebookDocument) {
      const markdownFileName = path.posix.basename(
        notebookPackagePaths(notebookPackageRoot).markdownPath
      );
      const metadata = buildNotebookPackageMetadata({
        id: native.notebookDocument.id,
        title: native.notebookDocument.title,
        createdAt:
          typeof native.notebookDocument.createdAt === 'string'
            ? native.notebookDocument.createdAt
            : options.capturedAt,
        updatedAt: native.notebookDocument.updatedAt,
        markdownFileName,
        existing: native.notebookDocument,
      });
      primaryText = serializeNotebookPackageMetadata(metadata);
      const serialized = serializeNotebookMarkdown({
        identity: {
          id: metadata.id,
          title: metadata.title,
          formatVersion: metadata.formatVersion,
        },
        content: new NotebookDocumentModel(
          native.notebookDocument.content as import('@tiptap/core').JSONContent,
          native.notebookDocument.title
        ).content,
        roots: {
          workspaceRoot: '/',
          packageRoot: `/${notebookPackageRoot}`,
        },
      });
      files.push({ relativePath: destinationPath, text: primaryText });
      files.push({
        relativePath: `${notebookPackageRoot}/${markdownFileName}`,
        text: serialized.markdown,
      });
      files.push(
        ...serialized.payloads.map((payload) => ({
          relativePath: `${notebookPackageRoot}/${payload.relativePath}`,
          text: payload.content,
        }))
      );
    } else {
      files.push({ relativePath: destinationPath, text: primaryText });
    }
  }
  if (!allocatedDestination) {
    files.push({ relativePath: provenancePath, text: provenanceText });
  }

  const catalogPayload: CatalogProjectionPayload | undefined =
    destination.kind === 'catalog-record'
      ? {
          sourceObjectId: sourceObject.id,
          providerStableId: sourceObject.stableId,
          sourceType: sourceObject.sourceType,
          name: sourceObject.name,
          registryId: sourceObject.registryId ?? null,
          metadata: sourceObject.metadata,
          content: sourceObject.content,
        }
      : undefined;
  const destinationHash = catalogPayload
    ? sha256(stableJson({ destination, catalogPayload }))
    : hashProjectionFiles(files);

  return {
    files,
    ...(destination.kind === 'package' && native?.attachmentAssets?.length
      ? { attachmentAssets: native.attachmentAssets }
      : {}),
    projection,
    nativeRepresentation,
    destinationObjectId,
    destination,
    ...(catalogPayload ? { catalogPayload } : {}),
    sourceHash,
    destinationHash,
    warnings,
    exception,
    formulaEvidence,
    converterId,
    converterVersion: options.converterVersion,
  };
}

export function projectionDestinationPrimaryPath(destination: ProjectionDestination): string {
  switch (destination.kind) {
    case 'file':
      return destination.relativePath;
    case 'package':
      return destination.primaryRelativePath;
    case 'catalog-record':
      return '';
  }
}

export function projectionPlanPrimaryPath(plan: Pick<ProjectionPlan, 'destination'>): string {
  return projectionDestinationPrimaryPath(plan.destination);
}

function projectionDestinationDirectory(destination: ProjectionDestination): string {
  switch (destination.kind) {
    case 'file':
      return path.posix.dirname(destination.relativePath);
    case 'package':
      return destination.rootRelativePath;
    case 'catalog-record':
      return destination.parentRelativePath || '.';
  }
}

function projectionDirectory(baseName: string, preferred: string | undefined): string {
  if (preferred === undefined) return `${IMPORT_ROOT}/${baseName}`;
  const normalized = preferred.replace(/\\/gu, '/');
  if (
    normalized !== preferred ||
    path.posix.normalize(normalized) !== normalized ||
    path.posix.isAbsolute(normalized) ||
    !isSafeWorkspaceRelativePath(normalized)
  ) {
    throw new Error('Existing projection package directory is unsafe.');
  }
  const topLevel = normalized.split('/')[0]?.normalize('NFC').toLowerCase();
  if (topLevel && ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel)) {
    throw new Error('Existing projection package directory uses a protected root.');
  }
  return normalized;
}

function nativeRepresentationFor(sourceObject: SourceObject): NativeRepresentation | null {
  const content = sourceObject.content;
  if (isRecord(content) && content.kind === 'dna_sequence_needs_sequence') {
    return 'dna_sequence_needs_sequence';
  }
  switch (normalizeSourceType(sourceObject.sourceType)) {
    case 'dna_sequence':
      return 'dna_sequence';
    case 'strain':
      return 'strain';
    default:
      return null;
  }
}

export function projectionDestinationObjectId(sourceObject: SourceObject): string {
  const providerIdentityId = providerIdentityDestinationObjectId(sourceObject);
  if (providerIdentityId) return providerIdentityId;
  const digest = sha256(sourceObject.stableId).slice(0, 24);
  switch (normalizeSourceType(sourceObject.sourceType)) {
    case 'dna_sequence':
    case 'rna_sequence':
      return `sequence-${digest}`;
    case 'protein':
      return `protein-${digest}`;
    case 'notebook':
    case 'notebook_entry':
      return `notebook-${digest}`;
    case 'protocol':
    case 'protocol_template':
      return `protocol-${digest}`;
    case 'protocol_execution':
    case 'protocol_run':
    case 'execution':
      return `protocol-run-${digest}`;
    default:
      return `file-${digest}`;
  }
}

export function projectionPackagePrimarySuffix(sourceObject: SourceObject): string {
  const baseName = projectionBaseName(sourceObject);
  const content = sourceObject.content;
  switch (normalizeSourceType(sourceObject.sourceType)) {
    case 'notebook':
    case 'notebook_entry':
      return '.forge/notebook.json';
    case 'strain':
      return `.forge/${BENCHLING_NATIVE_RECORD_PACKAGE_META_NAME}`;
    case 'dna_sequence':
      return isRecord(content) && content.kind === 'dna_sequence_needs_sequence'
        ? `.forge/${BENCHLING_NATIVE_RECORD_PACKAGE_META_NAME}`
        : `${baseName}.gb`;
    case 'rna_sequence':
      return `${baseName}.gb`;
    case 'protein':
      return `${baseName}.faa`;
    case 'protocol':
    case 'protocol_template':
      return `.forge/${PROTOCOL_PACKAGE_META_NAME}`;
    case 'protocol_execution':
    case 'protocol_run':
    case 'execution':
      return `.forge/${PROTOCOL_RUN_PACKAGE_META_NAME}`;
    default:
      return `${baseName}.md`;
  }
}

export type ProjectionDestinationVariant =
  | Readonly<{ kind: 'file'; extension: string }>
  | Readonly<{ kind: 'package'; primaryRelativePath: string }>
  | Readonly<{
      kind: 'catalog-record';
      catalogType: string;
      presentationKind: CatalogRecordPresentationKind;
    }>;

export function projectionDestinationVariant(
  sourceObject: SourceObject
): ProjectionDestinationVariant {
  const sourceType = normalizeSourceType(sourceObject.sourceType);
  if (sourceType === 'registry_record') {
    return { kind: 'catalog-record', catalogType: 'record', presentationKind: 'record' };
  }
  if (sourceType === 'strain') {
    return { kind: 'catalog-record', catalogType: 'sample', presentationKind: 'strain' };
  }
  if (
    sourceType === 'dna_sequence' &&
    isRecord(sourceObject.content) &&
    sourceObject.content.kind === 'dna_sequence_needs_sequence'
  ) {
    return { kind: 'catalog-record', catalogType: 'sequence', presentationKind: 'sequence' };
  }
  switch (sourceType) {
    case 'dna_sequence':
    case 'rna_sequence':
      return { kind: 'file', extension: '.gb' };
    case 'protein':
      return { kind: 'file', extension: '.faa' };
    case 'notebook':
    case 'notebook_entry':
    case 'protocol':
    case 'protocol_template':
    case 'protocol_execution':
    case 'protocol_run':
    case 'execution':
      return {
        kind: 'package',
        primaryRelativePath: projectionPackagePrimarySuffix(sourceObject),
      };
    default:
      return { kind: 'file', extension: '.md' };
  }
}

function buildNativeProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions
): NativeProjection | null {
  switch (normalizeSourceType(sourceObject.sourceType)) {
    case 'dna_sequence':
      if (
        isRecord(sourceObject.content) &&
        sourceObject.content.kind === 'dna_sequence_needs_sequence'
      ) {
        return buildNeedsSequenceProjection(sourceObject, options);
      }
      return buildSequenceProjection(sourceObject, options, 'DNA');
    case 'rna_sequence':
      return buildSequenceProjection(sourceObject, options, 'RNA');
    case 'protein':
      return buildProteinProjection(sourceObject);
    case 'strain':
      return buildStrainProjection(sourceObject, options);
    case 'registry_record':
      return {
        converterId: 'benchling-native-registry-v1',
        text: `${stableJson(sourceObject.content, 2)}\n`,
        warnings: [],
      };
    case 'notebook':
    case 'notebook_entry':
      return buildNotebookProjection(sourceObject, options);
    case 'protocol':
    case 'protocol_template':
      return buildNativeProtocolProjection(sourceObject, options);
    case 'protocol_execution':
    case 'protocol_run':
    case 'execution':
      return buildProtocolExecutionProjection(sourceObject, options);
    default:
      throw new Error(
        `No native converter is available for source type "${safeTypeName(sourceObject.sourceType)}".`
      );
  }
}

function buildStrainProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions
): NativeProjection {
  const content = requireRecord(sourceObject.content, 'Strain content must be an object.');
  if (content.kind !== 'benchling_strain') {
    throw new Error('Strain content must use the built-in Benchling strain representation.');
  }
  if (typeof content.displayName !== 'string' || content.displayName.length === 0) {
    throw new Error('Strain display name must be non-empty text.');
  }
  if (!Array.isArray(content.fields)) throw new Error('Strain source fields must be an array.');
  const fields = content.fields.map((field, index) => {
    const record = requireRecord(field, `Strain field ${index + 1} must be an object.`);
    if (
      typeof record.label !== 'string' ||
      typeof record.value !== 'string' ||
      record.position !== index
    ) {
      throw new Error(`Strain field ${index + 1} is invalid.`);
    }
    return { label: record.label, value: record.value, position: index };
  });
  const sourceEvidence = nativeRawSourceEvidence(sourceObject, '.txt');
  return {
    converterId: 'benchling-strain-v1',
    packageMetaName: BENCHLING_NATIVE_RECORD_PACKAGE_META_NAME,
    text: `${stableJson(
      {
        schema: 'dnaforge.benchling.native-record-evidence.v1',
        kind: 'strain',
        destinationObjectId: projectionDestinationObjectId(sourceObject),
        stableSourceId: sourceObject.stableId,
        displayName: content.displayName,
        fields,
      },
      2
    )}\n`,
    warnings: [],
    attachmentAssets: [
      {
        relativePath: `${options.notebookPackageRoot}/source/benchling-original.txt`,
        archiveSha256: sourceEvidence.sha256,
      },
    ],
  };
}

function buildNeedsSequenceProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions
): NativeProjection {
  const content = requireRecord(sourceObject.content, 'Needs-sequence content must be an object.');
  if (
    content.kind !== 'dna_sequence_needs_sequence' ||
    content.moleculeType !== 'DNA' ||
    content.bases !== '' ||
    !Array.isArray(content.annotations) ||
    content.annotations.length !== 0
  ) {
    throw new Error('Needs-sequence DNA content is invalid.');
  }
  const sourceEvidence = nativeSequenceSourceEvidence(sourceObject);
  if (!sourceEvidence) throw new Error('Needs-sequence DNA has no verified GenBank source.');
  return {
    converterId: 'benchling-dna-needs-sequence-v1',
    packageMetaName: BENCHLING_NATIVE_RECORD_PACKAGE_META_NAME,
    text: `${stableJson(
      {
        schema: 'dnaforge.benchling.native-record-evidence.v1',
        kind: 'dna_sequence_needs_sequence',
        destinationObjectId: projectionDestinationObjectId(sourceObject),
        stableSourceId: sourceObject.stableId,
        genbankMetadata: content.genbankMetadata,
      },
      2
    )}\n`,
    warnings: [],
    attachmentAssets: [
      {
        relativePath: `${options.notebookPackageRoot}/source/benchling-original.gb`,
        archiveSha256: sourceEvidence.sha256,
      },
    ],
  };
}

function nativeRawSourceEvidence(
  sourceObject: SourceObject,
  expectedExtension: string
): { sha256: string; sizeBytes: number; archivePartId: string; entryPath: string } {
  if (path.posix.extname(sourceObject.sourcePath ?? '').toLowerCase() !== expectedExtension) {
    throw new Error('Native record source path has an unexpected extension.');
  }
  const content = requireRecord(sourceObject.content, 'Native record content must be an object.');
  const rawAccess = requireRecord(content.rawAccess, 'Native record rawAccess must be an object.');
  const sha256 = normalizedSha256Text(content.sha256, 'Native record source SHA-256');
  const sizeBytes = nonnegativeSafeInteger(content.sizeBytes, 'Native record source size');
  const archivePartId = requireNonEmptyText(
    rawAccess.archivePartId,
    'Native record archive part ID'
  );
  const entryPath = requireNonEmptyText(rawAccess.entryPath, 'Native record archive entry path');
  if (entryPath !== sourceObject.sourcePath) {
    throw new Error('Native record source path does not match rawAccess.');
  }
  return { sha256, sizeBytes, archivePartId, entryPath };
}

function buildNativeProtocolProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions
): NativeProjection {
  const attachments = notebookAttachmentBindings(
    sourceObject,
    requireRecord(sourceObject.content, 'Protocol content must be an object.').attachments,
    'assets'
  );
  const projection = buildProtocolProjection(sourceObject, {
    destinationEntityId: options.destinationEntityId,
    capturedAt: options.capturedAt,
    converterVersion: options.converterVersion,
    links: protocolProjectionLinks(sourceObject, options.links),
    attachments,
    supportedFormulaNames: SUPPORTED_TABLE_FORMULAS,
  });
  return {
    converterId: projection.converterId,
    packageMetaName: PROTOCOL_PACKAGE_META_NAME,
    text: projection.text,
    warnings: projection.warnings,
    destinationObjectId: projection.destinationObjectId,
    attachmentAssets: projectionAttachmentAssets(options.notebookPackageRoot, attachments),
  };
}

function protocolProjectionLinks(
  sourceObject: SourceObject,
  links: OutboundLinkSet | undefined
): ProtocolProjectionLinkInput[] {
  if (!links) return [];
  const relationships = new Map(
    sourceObject.relationships.map((relationship) => [relationship.id, relationship])
  );
  return [
    ...links.localLinks.map(
      (link): ProtocolProjectionLinkInput => ({
        id: link.relationshipId,
        relation: link.relationType,
        state: 'exact',
        sourceTargetId: link.sourceTargetId,
        destinationTargetId: link.destinationTargetId,
        evidence: link.evidence,
      })
    ),
    ...links.externalLinks.map((link): ProtocolProjectionLinkInput => {
      const url = link.targetUrl ?? relationships.get(link.relationshipId)?.targetUrl;
      if (!url) throw new Error(`External relationship ${link.relationshipId} has no target URL.`);
      return {
        id: link.relationshipId,
        relation: link.relationType,
        state: 'external',
        url,
        evidence: link.evidence,
      };
    }),
    ...links.sourceBrokenLinks.map(
      (link): ProtocolProjectionLinkInput => ({
        id: link.relationshipId,
        relation: link.relationType,
        state: 'source_broken',
        ...(link.sourceTargetId ? { sourceTargetId: link.sourceTargetId } : {}),
        evidence: link.evidence,
      })
    ),
  ];
}

function buildNotebookProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions
): NativeProjection {
  const content = requireRecord(sourceObject.content, 'Notebook content must be an object.');
  const attachments = notebookAttachmentBindings(sourceObject, content.attachments, 'assets');
  const projection = buildNotebookHtmlProjection(sourceObject, {
    destinationEntityId: options.destinationEntityId,
    capturedAt: options.capturedAt,
    converterVersion: options.converterVersion,
    migrationRunId: options.runId,
    notebookPackagePath: options.notebookPackageRoot,
    attachments,
    localLinks: notebookLocalLinks(sourceObject, options.links),
    supportedFormulaNames: SUPPORTED_TABLE_FORMULAS,
  });
  const documentProvenance = isRecord(projection.document.provenance)
    ? projection.document.provenance
    : null;
  const benchlingEntryMetadata = isRecord(documentProvenance?.benchlingEntryMetadata)
    ? documentProvenance.benchlingEntryMetadata
    : null;
  return {
    converterId: projection.converterId,
    text: '',
    warnings: projection.warnings,
    destinationObjectId: projection.destinationObjectId,
    notebookDocument: projection.document,
    benchlingEntryMetadata,
    attachmentAssets: projectionAttachmentAssets(options.notebookPackageRoot, attachments),
  };
}

function notebookLocalLinks(
  sourceObject: SourceObject,
  links: OutboundLinkSet | undefined
): NotebookLocalLinkBinding[] {
  if (!links) return [];
  const relationships = new Map(
    sourceObject.relationships.map((relationship) => [relationship.id, relationship])
  );
  return links.localLinks.map((link) => {
    const relationship = relationships.get(link.relationshipId);
    const sourceRefs = [
      relationship?.targetUrl,
      ...link.evidence
        .filter(
          (entry) =>
            entry.kind === 'url' ||
            (link.relationType === 'embedded_entry_reference' && entry.kind === 'name')
        )
        .map((entry) => entry.value),
    ].filter((value): value is string => Boolean(value?.trim()));
    return {
      relationshipId: link.relationshipId,
      relationType: link.relationType,
      sourceTargetId: link.sourceTargetId,
      destinationTargetId: link.destinationTargetId,
      sourceRefs,
    };
  });
}

function notebookAttachmentBindings(
  sourceObject: SourceObject,
  value: unknown,
  nativeAssetRoot?: string
): NotebookAttachmentBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Notebook attachments must be an array.');
  const expectedHashes = new Set(sourceObject.attachmentHashes.map(normalizeSha256));
  const nativePathByHash = new Map<string, string>();
  return value.map((entry, index) => {
    const attachment = requireRecord(entry, `Notebook attachment ${index + 1} must be an object.`);
    const sourceRef = requireNonEmptyText(
      attachment.sourceRef,
      `Notebook attachment ${index + 1} source reference`
    );
    const fileName = requireNonEmptyText(
      attachment.fileName,
      `Notebook attachment ${index + 1} filename`
    );
    const hash = normalizeSha256(
      requireNonEmptyText(attachment.sha256, `Notebook attachment ${index + 1} SHA-256`)
    );
    if (!expectedHashes.has(hash)) {
      throw new Error(
        `Notebook attachment ${index + 1} is not present in captured attachment evidence.`
      );
    }
    const digest = hash.slice('sha256:'.length);
    const mediaType =
      attachment.mediaType === undefined
        ? undefined
        : requireNonEmptyText(attachment.mediaType, `Notebook attachment ${index + 1} media type`);
    const proposedWorkspacePath = nativeAssetRoot
      ? `${nativeAssetRoot}/${nativeAttachmentFileName(fileName, digest)}`
      : `.dnaforge/migration/archive/blobs/sha256/${digest.slice(0, 2)}/${digest}`;
    const workspacePath = nativePathByHash.get(hash) ?? proposedWorkspacePath;
    nativePathByHash.set(hash, workspacePath);
    return {
      sourceRef,
      fileName,
      hash,
      workspacePath,
      ...(mediaType ? { mediaType } : {}),
    };
  });
}

function projectionAttachmentAssets(
  packageRoot: string,
  attachments: readonly NotebookAttachmentBinding[]
): Array<{ relativePath: string; archiveSha256: string }> {
  const assets = new Map<string, { relativePath: string; archiveSha256: string }>();
  for (const attachment of attachments) {
    const asset = {
      relativePath: `${packageRoot}/${attachment.workspacePath}`,
      archiveSha256: attachment.hash.slice('sha256:'.length),
    };
    const collisionKey = asset.relativePath.normalize('NFC').toLowerCase();
    const existing = assets.get(collisionKey);
    if (existing && existing.archiveSha256 !== asset.archiveSha256) {
      throw new Error(`Native attachment path collision: ${asset.relativePath}`);
    }
    if (!existing) assets.set(collisionKey, asset);
  }
  return [...assets.values()];
}

function nativeAttachmentFileName(fileName: string, digest: string): string {
  const leaf = fileName.replace(/\\/gu, '/').split('/').at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  const rawStem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const rawExtension = dot > 0 ? leaf.slice(dot) : '';
  const stem = rawStem
    .normalize('NFC')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  const extension = /^\.[A-Za-z0-9]{1,12}$/u.test(rawExtension) ? rawExtension.toLowerCase() : '';
  return `${stem || 'attachment'}-${digest.slice(0, 12)}${extension}`;
}

function normalizeSha256(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('Attachment SHA-256 is invalid.');
  return `sha256:${normalized}`;
}

function buildProtocolExecutionProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions
): NativeProjection {
  const projection = buildProtocolRunProjection(sourceObject, {
    destinationEntityId: options.destinationEntityId,
    capturedAt: options.capturedAt,
    converterVersion: options.converterVersion,
  });
  return {
    converterId: projection.converterId,
    packageMetaName: PROTOCOL_RUN_PACKAGE_META_NAME,
    text: projection.text,
    warnings: projection.warnings,
    destinationObjectId: projection.destinationObjectId,
  };
}

function buildSequenceProjection(
  sourceObject: SourceObject,
  options: NativeProjectionOptions,
  expectedMoleculeType: 'DNA' | 'RNA'
): NativeProjection {
  const content = requireRecord(sourceObject.content, 'Sequence content must be an object.');
  if (content.moleculeType !== expectedMoleculeType) {
    throw new Error(`Sequence molecule type must be ${expectedMoleculeType}.`);
  }
  if (typeof content.bases !== 'string' || content.bases.length === 0) {
    throw new Error('Sequence bases must be a non-empty string.');
  }
  const bases = content.bases;
  const alphabet = expectedMoleculeType === 'DNA' ? DNA_ALPHABET : RNA_ALPHABET;
  if (!alphabet.test(bases)) {
    throw new Error(
      `${expectedMoleculeType} sequence contains modified or incompatible bases and cannot be represented natively.`
    );
  }
  if (content.topology !== 'linear' && content.topology !== 'circular') {
    throw new Error('Sequence topology must be linear or circular.');
  }
  if (!Array.isArray(content.annotations)) {
    throw new Error('Sequence annotations must be an array.');
  }
  if (content.description !== undefined && typeof content.description !== 'string') {
    throw new Error('Sequence description must be text.');
  }

  const normalizedAnnotations = content.annotations.map((value, index) =>
    normalizeAnnotation(value, index, bases.length, content.topology === 'circular')
  );
  const annotations = normalizedAnnotations.map((value) => value.annotation);
  const sequence: AnnotatedSequence = {
    id: projectionDestinationObjectId(sourceObject),
    name: sourceObject.name,
    sequence: bases,
    length: bases.length,
    circular: content.topology === 'circular',
    description: content.description,
    annotations,
    ...(expectedMoleculeType === 'RNA' ? { molecule: 'RNA' } : {}),
  };

  let serialized = serializeGenBank(sequence);
  serialized = replaceGenBankDate(serialized, projectionDate(sourceObject, options.capturedAt));
  assertSequenceRoundTrip(serialized, sequence);
  const sourceEvidence = nativeSequenceSourceEvidence(sourceObject);

  return {
    converterId: expectedMoleculeType === 'DNA' ? 'benchling-dna-genbank' : 'benchling-rna-genbank',
    extension: '.gb',
    text: serialized,
    warnings: normalizedAnnotations.flatMap((value) => value.warnings),
    ...(sourceEvidence
      ? {
          attachmentAssets: [
            {
              relativePath: `${options.notebookPackageRoot}/source/benchling-original.gb`,
              archiveSha256: sourceEvidence.sha256,
            },
          ],
        }
      : {}),
  };
}

function buildProteinProjection(sourceObject: SourceObject): NativeProjection {
  const content = requireRecord(sourceObject.content, 'Protein content must be an object.');
  if (typeof content.aminoAcids !== 'string' || content.aminoAcids.length === 0) {
    throw new Error('Protein amino-acid sequence must be a non-empty string.');
  }
  if (!PROTEIN_ALPHABET.test(content.aminoAcids)) {
    throw new Error(
      'Protein contains modified or nonstandard amino acids and cannot be represented natively.'
    );
  }
  if (content.description !== undefined && typeof content.description !== 'string') {
    throw new Error('Protein description must be text.');
  }

  const recordName =
    sanitizeFastaHeader(projectionDestinationObjectId(sourceObject)) || 'protein-sequence';
  const description = sanitizeFastaHeader(content.description ?? sourceObject.name);
  const header = description ? `>${recordName} ${description}` : `>${recordName}`;
  const sequenceLines = content.aminoAcids.match(/.{1,60}/g) ?? [];

  return {
    converterId: 'benchling-protein-fasta',
    extension: '.faa',
    text: `${header}\n${sequenceLines.join('\n')}\n`,
    warnings: [],
  };
}

function normalizeAnnotation(
  value: unknown,
  index: number,
  sequenceLength: number,
  circular: boolean
): { annotation: Annotation; warnings: string[] } {
  const input = requireRecord(value, `Annotation ${index + 1} must be an object.`);
  const type = requireNonEmptyText(input.type, `Annotation ${index + 1} type`);
  const label = requireNonEmptyText(input.label, `Annotation ${index + 1} label`);
  const sourceStart = requireCoordinate(input.start, `Annotation ${index + 1} start`);
  const sourceEnd = requireCoordinate(input.end, `Annotation ${index + 1} end`);
  const direction = normalizeStrand(input.strand, index);
  const compoundLocation = normalizeCompoundLocation(
    input.qualifiers,
    index,
    sequenceLength,
    circular
  );
  if (
    compoundLocation &&
    (compoundLocation.start !== sourceStart ||
      compoundLocation.end !== sourceEnd ||
      compoundLocation.complement !== (direction === -1))
  ) {
    throw new Error(
      `Annotation ${index + 1} private compound location disagrees with its coordinates or strand.`
    );
  }
  const start = compoundLocation?.start ?? sourceStart;
  const end = compoundLocation?.end ?? sourceEnd;
  if (start > sequenceLength || end > sequenceLength || (start > end && !circular)) {
    throw new Error(
      `Annotation ${index + 1} coordinates ${start}..${end} fall outside a ${sequenceLength}-base sequence.`
    );
  }
  const segments =
    compoundLocation?.segments ??
    (start > end
      ? [
          { start, end: sequenceLength },
          { start: 1, end },
        ]
      : undefined);
  const qualifiers = normalizeQualifiers(input.qualifiers, index);
  const translations = normalizeTranslations(input.translations, index);
  if (translations.values.length > 0) qualifiers.translation = translations.values;
  if (input.color !== undefined) {
    if (
      typeof input.color !== 'string' ||
      input.color.trim() === '' ||
      input.color.includes('\r') ||
      input.color.includes('\n') ||
      input.color.includes('\0')
    ) {
      throw new Error(`Annotation ${index + 1} color must be single-line text.`);
    }
    qualifiers.dnaforge_color = [input.color];
  }
  qualifiers.dnaforge_original_type = [type];
  qualifiers.label = [label, ...(qualifiers.label?.slice(1) ?? [])];

  const nativeType = SAFE_FEATURE_KEY.test(type) ? type : 'misc_feature';
  return {
    annotation: {
      name: label,
      label,
      type: nativeType,
      start,
      end,
      direction,
      color: typeof input.color === 'string' ? input.color : undefined,
      qualifiers: sortQualifierRecord(qualifiers),
      ...(segments ? { segments } : {}),
    },
    warnings: [
      ...(compoundLocation
        ? [
            `Converted the private Benchling compound location on annotation ${index + 1} into portable feature segments; the immutable Benchling source remains preserved.`,
          ]
        : start > end
          ? [
              `Converted origin-spanning annotation ${index + 1} into portable compound feature segments; the immutable Benchling source remains preserved.`,
            ]
          : []),
      ...(translations.normalizedTerminalStops === 0
        ? []
        : [
            `Normalized ${translations.normalizedTerminalStops} terminal stop marker${translations.normalizedTerminalStops === 1 ? '' : 's'} from annotation ${index + 1} translation${translations.values.length === 1 ? '' : 's'}; the immutable Benchling source remains preserved.`,
          ]),
      ...(translations.preservedSourceStops === 0
        ? []
        : [
            `Preserved ${translations.preservedSourceStops} source stop marker${translations.preservedSourceStops === 1 ? '' : 's'} from annotation ${index + 1} translation${translations.values.length === 1 ? '' : 's'} in the native GenBank qualifier; the immutable Benchling source remains preserved.`,
          ]),
    ],
  };
}

function normalizeCompoundLocation(
  qualifiersValue: unknown,
  annotationIndex: number,
  sequenceLength: number,
  circular: boolean
): {
  start: number;
  end: number;
  complement: boolean;
  segments: Array<{ start: number; end: number }>;
} | null {
  if (qualifiersValue === undefined) return null;
  const qualifiers = requireRecord(
    qualifiersValue,
    `Annotation ${annotationIndex + 1} qualifiers must be an object.`
  );
  if (qualifiers._locationString === undefined) return null;
  const rawValues = Array.isArray(qualifiers._locationString)
    ? qualifiers._locationString
    : [qualifiers._locationString];
  if (rawValues.length !== 1 || typeof rawValues[0] !== 'string') {
    throw new Error(
      `Annotation ${annotationIndex + 1} private compound location must contain exactly one text value.`
    );
  }
  const locationString = rawValues[0].trim();
  if (!FORWARD_JOIN_LOCATION.test(locationString) && !REVERSE_JOIN_LOCATION.test(locationString)) {
    throw new Error(
      `Annotation ${annotationIndex + 1} private compound location is not a portable join location.`
    );
  }

  const parsed = parseFeatureLocation(locationString);
  const location = circular ? applyComplementOriginWrap(parsed, sequenceLength) : parsed;
  if (!location.segments || location.segments.length < 2) {
    throw new Error(`Annotation ${annotationIndex + 1} compound location has no feature segments.`);
  }
  if (
    location.segments.some(
      (candidate) =>
        candidate.start < 1 || candidate.end < candidate.start || candidate.end > sequenceLength
    ) ||
    (location.start > location.end && !circular)
  ) {
    throw new Error(
      `Annotation ${annotationIndex + 1} compound location falls outside a ${sequenceLength}-base sequence.`
    );
  }
  return {
    start: location.start,
    end: location.end,
    complement: location.complement,
    segments: location.segments,
  };
}

function normalizeQualifiers(value: unknown, annotationIndex: number): Record<string, string[]> {
  if (value === undefined) return {};
  const input = requireRecord(
    value,
    `Annotation ${annotationIndex + 1} qualifiers must be an object.`
  );
  const result: Record<string, string[]> = {};
  for (const key of Object.keys(input)) {
    if (key === '_locationString') continue;
    if (!SAFE_QUALIFIER_KEY.test(key) || key.startsWith('_')) {
      throw new Error(
        `Annotation ${annotationIndex + 1} qualifier key "${safeTypeName(key)}" is not portable.`
      );
    }
    const rawValue = input[key];
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (values.length === 0 || values.some((entry) => typeof entry !== 'string')) {
      throw new Error(
        `Annotation ${annotationIndex + 1} qualifier "${key}" must contain text values.`
      );
    }
    result[key] = values as string[];
  }
  return result;
}

function normalizeTranslations(
  value: unknown,
  annotationIndex: number
): { values: string[]; normalizedTerminalStops: number; preservedSourceStops: number } {
  if (value === undefined) {
    return { values: [], normalizedTerminalStops: 0, preservedSourceStops: 0 };
  }
  const translations = Array.isArray(value) ? value : [value];
  if (translations.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Annotation ${annotationIndex + 1} translations must contain text values.`);
  }
  return {
    values: translations as string[],
    normalizedTerminalStops: 0,
    preservedSourceStops: 0,
  };
}

function normalizeStrand(value: unknown, annotationIndex: number): AnnotationDirection {
  if (value === 1 || value === '+' || value === 'forward') return 1;
  if (value === -1 || value === '-' || value === 'reverse') return -1;
  if (value === 0 || value === 'none' || value === undefined || value === null) return 0;
  throw new Error(`Annotation ${annotationIndex + 1} strand is not recognized.`);
}

function assertSequenceRoundTrip(serialized: string, expected: AnnotatedSequence): void {
  const parsed = parseGenBankFull(serialized);
  if (
    parsed.sequence !== expected.sequence ||
    Boolean(parsed.circular) !== Boolean(expected.circular) ||
    parsed.molecule !== expected.molecule
  ) {
    throw new Error('Native GenBank round-trip did not preserve sequence, topology or molecule.');
  }
  if (parsed.annotations.length !== expected.annotations.length) {
    throw new Error('Native GenBank round-trip did not preserve every annotation.');
  }
  for (let index = 0; index < expected.annotations.length; index += 1) {
    const before = expected.annotations[index];
    const after = parsed.annotations[index];
    const mismatchPath = annotationRoundTripMismatchPath(before, after);
    if (mismatchPath !== null) {
      throw new Error(
        `Native GenBank round-trip changed annotation ${index + 1} at ${mismatchPath}.`
      );
    }
  }
}

function annotationRoundTripMismatchPath(before: Annotation, after: Annotation): string | null {
  if (before.type !== after.type) return 'type';
  if (before.name !== after.name) return 'label';
  if (before.start !== after.start) return 'start';
  if (before.end !== after.end) return 'end';
  if (before.direction !== after.direction) return 'direction';
  if (stableJson(before.segments ?? []) !== stableJson(after.segments ?? [])) return 'segments';

  const expectedQualifiers = before.qualifiers ?? {};
  const actualQualifiers = withoutInternalQualifiers(after.qualifiers);
  const expectedKeys = Object.keys(expectedQualifiers).filter((key) => !key.startsWith('_'));
  const actualKeys = Object.keys(actualQualifiers);
  if (stableJson(expectedKeys) !== stableJson(actualKeys)) return 'qualifierKeys';
  for (const key of expectedKeys) {
    const expectedValues = expectedQualifiers[key] ?? [];
    const actualValues = actualQualifiers[key] ?? [];
    if (expectedValues.length !== actualValues.length) return `qualifiers.${key}.length`;
    for (let valueIndex = 0; valueIndex < expectedValues.length; valueIndex += 1) {
      if (expectedValues[valueIndex] !== actualValues[valueIndex]) {
        return `qualifiers.${key}[${valueIndex}]`;
      }
    }
  }
  return null;
}

function withoutInternalQualifiers(
  qualifiers: Record<string, string[]> | undefined
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(qualifiers ?? {}).filter(([key]) => !key.startsWith('_'))
  );
}

function buildArtifactCard(sourceObject: SourceObject, exception: string): string {
  const preview = artifactPreview(sourceObject.content);
  const rawSource = artifactRawSource(sourceObject.content);
  const sourceUrl = sanitizeSourceUrl(sourceObject.sourceUrl);
  const lines = [
    `# ${escapeMarkdownInline(singleLine(sourceObject.name) || 'Benchling object')}`,
    '',
    '> [!WARNING]',
    '> **Native conversion exception**',
    `> ${escapeMarkdownInline(singleLine(exception))}`,
    '',
    `- Source type: \`${escapeCodeSpan(singleLine(sourceObject.sourceType))}\``,
    `- Source ID: \`${escapeCodeSpan(singleLine(sourceObject.stableId))}\``,
  ];
  if (sourceUrl) lines.push(`- Source URL: ${sourceUrl}`);
  if (rawSource) {
    lines.push(
      `- Preserved raw source: [${escapeMarkdownInline(rawSource.fileName)}](${rawSource.uri})`
    );
  }
  if (preview) {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(preview) + 1));
    lines.push('', '## Preserved preview', '', fence, preview, fence);
  }
  lines.push('', 'The immutable source archive remains the authority for this object.', '');
  return lines.join('\n');
}

function artifactRawSource(content: unknown): { fileName: string; uri: string } | null {
  if (!isRecord(content) || typeof content.sha256 !== 'string') return null;
  const rawAccess = content.rawAccess;
  if (!isRecord(rawAccess) || typeof rawAccess.entryPath !== 'string') return null;
  const fileName = rawAccess.entryPath.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  if (!fileName) return null;
  try {
    return {
      fileName,
      uri: buildPreservedMigrationRawSourceUri({
        sha256: content.sha256,
        fileName,
        mediaType: typeof content.mediaType === 'string' ? content.mediaType : null,
      }),
    };
  } catch {
    return null;
  }
}

function artifactPreview(content: unknown): string | null {
  if (!isRecord(content) || typeof content.preview !== 'string') return null;
  const normalized = content.preview.replace(/\r\n?/g, '\n').split('\0').join('\uFFFD');
  const redacted = redactUrlQueries(normalized);
  const codePoints = Array.from(redacted);
  return codePoints.length <= PREVIEW_LIMIT
    ? redacted
    : `${codePoints.slice(0, PREVIEW_LIMIT).join('')}\n[preview truncated]`;
}

function buildProvenance(
  sourceObject: SourceObject,
  options: ProjectionPlanOptions,
  projection: {
    sourceHash: string;
    converterId: string;
    projection: ProjectionKind;
    nativeRepresentation: NativeRepresentation | null;
    destinationObjectId: string;
    benchlingEntryMetadata?: Record<string, unknown> | null;
  }
): string {
  const common = {
    version: 1,
    immutable: true,
    runId: options.runId,
    sourceId: sourceObject.id,
    stableSourceId: sourceObject.stableId,
    sourceType: sourceObject.sourceType,
    sourceUrl: sanitizeSourceUrl(sourceObject.sourceUrl),
    sourceSchemaId: sourceObject.schemaId ?? null,
    sourceCreatedAt: sourceObject.createdAt ?? null,
    sourceModifiedAt: sourceObject.modifiedAt ?? null,
    capturedAt: options.capturedAt,
    sourceHash: projection.sourceHash,
    projection: projection.projection,
    nativeRepresentation: projection.nativeRepresentation,
    converterId: projection.converterId,
    converterVersion: options.converterVersion,
  };
  if (projection.converterId !== 'benchling-notebook-html-v1') {
    return `${stableJson(common, 2)}\n`;
  }

  const compactIdentity = (key: string, value: unknown): Record<string, string | null> => {
    const compact = compactNotebookProvenanceText(value);
    if (compact !== null) return { [key]: compact };
    if (typeof value !== 'string' || !value) return { [key]: null };
    return { [key]: null, [`${key}Hash`]: sha256(value) };
  };
  const compactMetadata = compactNotebookEntryMetadata(projection.benchlingEntryMetadata);
  const notebookProvenance = {
    version: 1,
    immutable: true,
    ...compactIdentity('runId', options.runId),
    ...compactIdentity('sourceId', sourceObject.id),
    ...compactIdentity('stableSourceId', sourceObject.stableId),
    sourceType: normalizeSourceType(sourceObject.sourceType),
    ...compactIdentity('sourceUrl', sanitizeSourceUrl(sourceObject.sourceUrl)),
    ...compactIdentity('sourceSchemaId', sourceObject.schemaId ?? null),
    ...compactIdentity('sourceCreatedAt', sourceObject.createdAt ?? null),
    ...compactIdentity('sourceModifiedAt', sourceObject.modifiedAt ?? null),
    ...compactIdentity('capturedAt', options.capturedAt),
    ...compactIdentity('destinationObjectId', projection.destinationObjectId),
    sourceHash: projection.sourceHash,
    projection: projection.projection,
    converterId: projection.converterId,
    ...compactIdentity('converterVersion', options.converterVersion),
    benchlingEntryMetadata: compactMetadata,
  };
  const text = `${stableJson(notebookProvenance, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_BENCHLING_NOTEBOOK_PROVENANCE_BYTES) {
    throw new Error('Benchling notebook provenance exceeded its bounded source-details contract.');
  }
  return text;
}

function compactNotebookProvenanceText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = replaceControlCharacters(value, '\uFFFD').trim();
  if (!compact || Buffer.byteLength(compact, 'utf8') > NOTEBOOK_PROVENANCE_FIELD_MAX_BYTES) {
    return null;
  }
  return compact;
}

function compactNotebookEntryMetadata(
  value: Record<string, unknown> | null | undefined
): Record<string, string> | null {
  if (!value) return null;
  const compact: Record<string, string> = {
    schema: 'dnaforge.benchling.entry-export-metadata.v1',
  };
  for (const key of [
    'project',
    'author',
    'status',
    'entryCreatedOn',
    'entryLastModified',
    'exportGeneratedOn',
  ] as const) {
    const field = compactNotebookProvenanceText(value[key]);
    if (field !== null) compact[key] = field;
  }
  return compact;
}

function projectionBaseName(sourceObject: SourceObject): string {
  const sourceType = normalizeSourceType(sourceObject.sourceType);
  if (sourceType === 'notebook' || sourceType === 'notebook_entry') {
    const nativeToken = sha256(sourceObject.stableId).slice(0, 16);
    const name = sanitizeHashedPathToken(
      sourceObject.name,
      'object',
      NOTEBOOK_PACKAGE_STEM_MAX_LENGTH - nativeToken.length - 2,
      8
    );
    return `${name}__${nativeToken}`;
  }

  const name = sanitizePathToken(sourceObject.name, 'object', 40);
  return `${name}__${sha256(sourceObject.stableId).slice(0, 16)}`;
}

function sanitizePathToken(value: string, fallback: string, maxLength: number): string {
  const normalized = normalizePathToken(value);
  const truncated = normalized.slice(0, maxLength).replace(/[._-]+$/g, '');
  return truncated && truncated !== '.' && truncated !== '..' ? truncated : fallback;
}

function sanitizeHashedPathToken(
  value: string,
  fallback: string,
  maxLength: number,
  hashLength: number
): string {
  const normalized = normalizePathToken(value) || fallback;
  if (normalized.length <= maxLength) return normalized;
  const digest = sha256(String(value ?? '').normalize('NFKC')).slice(0, hashLength);
  const prefix = normalized.slice(0, maxLength - digest.length - 1).replace(/[._-]+$/g, '');
  return prefix ? `${prefix}_${digest}` : digest.slice(0, maxLength);
}

function normalizePathToken(value: string): string {
  return replaceControlCharacters(String(value ?? '').normalize('NFKC'), '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^_+|_+$/g, '');
}

function sanitizeSourceUrl(value: string): string | null {
  if (isBenchlingLocalExportProvenanceUrn(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function redactUrlQueries(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"'`]+/gi, (rawUrl) => {
    const trailing = rawUrl.match(/[),.;:!?]+$/)?.[0] ?? '';
    const candidate = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
    const sanitized = sanitizeSourceUrl(candidate);
    return `${sanitized ?? '[invalid URL]'}${trailing}`;
  });
}

function projectionDate(sourceObject: SourceObject, capturedAt: string): Date {
  for (const candidate of [sourceObject.modifiedAt, sourceObject.createdAt, capturedAt]) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date('1970-01-01T00:00:00.000Z');
}

function replaceGenBankDate(serialized: string, date: Date): string {
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  const formatted = `${String(date.getUTCDate()).padStart(2, '0')}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
  return serialized.replace(/^(LOCUS\s+.*)\d{2}-[A-Z]{3}-\d{4}$/m, `$1${formatted}`);
}

export function hashProjectionFiles(files: readonly ProjectionFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const bytes =
      file.text !== undefined ? Buffer.from(file.text, 'utf8') : Buffer.from(file.bytes);
    hash.update(String(Buffer.byteLength(file.relativePath, 'utf8')));
    hash.update(':');
    hash.update(file.relativePath);
    hash.update(':');
    hash.update(String(bytes.byteLength));
    hash.update(':');
    hash.update(bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function normalizeSourceType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function sortQualifierRecord(value: Record<string, string[]>): Record<string, string[]> {
  const keys = Object.keys(value);
  const orderedKeys = keys.includes('label')
    ? ['label', ...keys.filter((key) => key !== 'label')]
    : keys;
  return Object.fromEntries(orderedKeys.map((key) => [key, [...value[key]]]));
}

function sanitizeFastaHeader(value: string): string {
  return singleLine(value).replace(/>/g, '').replace(/\s+/g, ' ').trim();
}

function singleLine(value: string): string {
  return replaceControlCharacters(String(value ?? ''), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeMarkdownInline(value: string): string {
  const markdownSyntax = new Set('\\`*_{}[]()#+.!|>~-');
  return Array.from(value, (character) =>
    markdownSyntax.has(character) ? `\\${character}` : character
  ).join('');
}

function escapeCodeSpan(value: string): string {
  return value.replace(/`/g, '\u02CB');
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
}

function safeTypeName(value: string): string {
  return singleLine(value).slice(0, 120) || 'unknown';
}

function requireCoordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be non-empty text.`);
  }
  return value;
}

function normalizedSha256Text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, '');
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? replacement : character;
  }).join('');
}

export function projectionSourceHash(sourceObject: unknown): string {
  return sha256(stableJson(sourceObject));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown, indentation?: number): string {
  return JSON.stringify(sortJsonValue(value), null, indentation);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}
