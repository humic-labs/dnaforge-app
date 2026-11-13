export const HOSTED_REFERENCE_EXTERNAL_ANNOTATION_SOURCE_V1 =
  'dnaforge-hosted-reference-external-annotation-source.v1' as const;

const ACCESSION = /^GC[AF]_[0-9]+\.[0-9]+$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.gff3?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_ANNOTATION_BYTES = 4 * 1024 * 1024 * 1024;

export interface HostedReferenceExternalAnnotationSourceV1 {
  readonly contract: typeof HOSTED_REFERENCE_EXTERNAL_ANNOTATION_SOURCE_V1;
  readonly provider: 'figshare';
  readonly assemblyId: string;
  readonly accession: string;
  readonly articleId: number;
  readonly articleVersion: number;
  readonly fileId: number;
  readonly fileName: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly publishedDate: string;
  readonly license: string;
  readonly attribution: string;
  readonly sourceUrl: string;
}

export function validateHostedReferenceExternalAnnotationSourceV1(
  value: unknown,
  expectedAccession?: string
): HostedReferenceExternalAnnotationSourceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('External annotation source must be an object.');
  }
  const source = value as Record<string, unknown>;
  const allowed = new Set([
    'contract',
    'provider',
    'assemblyId',
    'accession',
    'articleId',
    'articleVersion',
    'fileId',
    'fileName',
    'sha256',
    'byteLength',
    'publishedDate',
    'license',
    'attribution',
    'sourceUrl',
  ]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`External annotation source contains unsupported keys: ${unknown.join(', ')}`);
  }
  if (source.contract !== HOSTED_REFERENCE_EXTERNAL_ANNOTATION_SOURCE_V1) {
    throw new Error(
      `External annotation source must use ${HOSTED_REFERENCE_EXTERNAL_ANNOTATION_SOURCE_V1}.`
    );
  }
  if (source.provider !== 'figshare') {
    throw new Error('External annotation source provider must be figshare.');
  }
  const assemblyId = requiredText(source.assemblyId, 'assemblyId');
  const accession = requiredText(source.accession, 'accession');
  if (!SAFE_ID.test(assemblyId)) throw new Error('External annotation assemblyId is unsafe.');
  if (!ACCESSION.test(accession)) {
    throw new Error('External annotation accession must be an exact versioned NCBI assembly.');
  }
  if (expectedAccession !== undefined && accession !== expectedAccession) {
    throw new Error('External annotation accession does not match the requested NCBI assembly.');
  }
  const articleId = positiveInteger(source.articleId, 'articleId');
  const articleVersion = positiveInteger(source.articleVersion, 'articleVersion');
  const fileId = positiveInteger(source.fileId, 'fileId');
  const fileName = requiredText(source.fileName, 'fileName');
  if (!SAFE_FILE_NAME.test(fileName)) {
    throw new Error('External annotation fileName must be a safe GFF or GFF3 filename.');
  }
  const sha256 = requiredText(source.sha256, 'sha256');
  if (!SHA256.test(sha256)) {
    throw new Error('External annotation sha256 must be lowercase hexadecimal SHA-256.');
  }
  const byteLength = positiveInteger(source.byteLength, 'byteLength');
  if (byteLength > MAX_ANNOTATION_BYTES) {
    throw new Error('External annotation byteLength exceeds the bounded source limit.');
  }
  const publishedDate = requiredText(source.publishedDate, 'publishedDate');
  if (!ISO_DATE.test(publishedDate)) {
    throw new Error('External annotation publishedDate must use YYYY-MM-DD.');
  }
  const license = requiredText(source.license, 'license');
  const attribution = requiredText(source.attribution, 'attribution');
  const sourceUrl = requiredText(source.sourceUrl, 'sourceUrl');
  const sourcePage = new URL(sourceUrl);
  if (
    sourcePage.protocol !== 'https:' ||
    sourcePage.hostname !== 'figshare.com' ||
    sourcePage.username ||
    sourcePage.password ||
    sourcePage.search ||
    sourcePage.hash ||
    !sourcePage.pathname.endsWith(`/${articleId}`)
  ) {
    throw new Error('External annotation sourceUrl must be the exact public Figshare article URL.');
  }
  return Object.freeze({
    contract: HOSTED_REFERENCE_EXTERNAL_ANNOTATION_SOURCE_V1,
    provider: 'figshare',
    assemblyId,
    accession,
    articleId,
    articleVersion,
    fileId,
    fileName,
    sha256,
    byteLength,
    publishedDate,
    license,
    attribution,
    sourceUrl: sourcePage.href,
  });
}

export function figshareExternalAnnotationDatasetId(
  source: HostedReferenceExternalAnnotationSourceV1
): string {
  return `10.6084/m9.figshare.${source.articleId}.v${source.articleVersion}`;
}

export function figshareExternalAnnotationDownloadUrl(
  source: HostedReferenceExternalAnnotationSourceV1
): string {
  return `https://ndownloader.figshare.com/files/${source.fileId}`;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`External annotation ${label} must be a positive safe integer.`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`External annotation ${label} must be non-empty text.`);
  }
  return value.trim();
}
