import { createHash } from 'node:crypto';

import type { WorkspaceSyncFile } from '@waypoint/share-bundle';
import { parseSequencePackageAdmissionDescriptor } from '@waypoint/share-bundle/sequence-package-admission';
import { parseGenBankFull, parseGenBankRecords } from '@waypoint/sequence-utils';

import type {
  WorkspaceSyncMergeSequenceSummary,
  WorkspaceSyncMergeSideSummary,
} from '../shared/workspace-sync-ipc';
import { readVerifiedWorkspaceSyncFile } from './workspace-sync-blob-cache';
import type { ReconcileResource } from './workspace-sync-reconcile';

const COMPARISON_MAX_BYTES = 2 * 1024 * 1024;
const COMPARISON_MAX_LABELS = 12;

export async function summarizeReconcileResource(
  resource: ReconcileResource | null
): Promise<WorkspaceSyncMergeSideSummary | null> {
  if (!resource) return null;
  let preview: string | null = null;
  const file = resource.files[0];
  if (
    resource.kind === 'file' &&
    file &&
    (file.contentType.startsWith('text/') || file.contentType === 'application/json')
  ) {
    try {
      preview = new TextDecoder('utf-8', { fatal: true })
        .decode(await readComparisonBytes(file))
        .slice(0, 4000);
    } catch {}
  }
  const sequence =
    resource.kind === 'sequence-package' ? await sequenceSummary(resource) : undefined;
  return {
    path: resource.path,
    fileCount: resource.files.length,
    sizeBytes: resource.files.reduce((total, entry) => total + entry.sizeBytes, 0),
    contentHash: resource.contentHash,
    preview,
    ...(sequence ? { sequence } : {}),
  };
}

async function sequenceSummary(
  resource: ReconcileResource
): Promise<WorkspaceSyncMergeSequenceSummary | undefined> {
  const marker = resource.files.find(
    (file) => file.relativePath === `${resource.path}/.forge/plasmid.json`
  );
  if (!marker) return undefined;
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await readComparisonBytes(marker))
    );
  } catch {
    return undefined;
  }
  const authority = parseSequencePackageAdmissionDescriptor(document, marker.relativePath);
  if (!authority.ok) return undefined;
  const { descriptor } = authority;
  const product = resource.files.find((file) => file.relativePath === descriptor.productPath);
  if (!product) return undefined;
  const relative = (path: string) => path.slice(resource.path.length + 1);
  const files = new Map(resource.files.map((file) => [file.relativePath, file]));
  const declared = new Map(descriptor.members.map((member) => [member.path, member]));
  const attachments = descriptor.requiredPaths
    .filter((path) => path !== marker.relativePath && path !== product.relativePath)
    .sort()
    .map((path) => ({
      memberId: declared.get(path)?.memberId ?? null,
      path: relative(path),
      role: declared.get(path)?.role ?? 'legacy primer export',
      sha256: files.get(path)?.sha256 ?? '',
    }));
  const assembly =
    document.assembly && typeof document.assembly === 'object' && !Array.isArray(document.assembly)
      ? (document.assembly as Record<string, unknown>)
      : null;
  const summary: WorkspaceSyncMergeSequenceSummary = {
    productPath: relative(product.relativePath),
    productSha256: product.sha256,
    metadataSha256: marker.sha256,
    attachmentSha256: hash(JSON.stringify(attachments)),
    attachmentCount: attachments.length,
    attachments: attachments.slice(0, COMPARISON_MAX_LABELS),
    buildRecordCount: assembly
      ? (assembly.accepted ? 1 : 0) +
        (Array.isArray(assembly.history) ? assembly.history.length : 0)
      : 0,
    inspectionUnavailableReason: null,
  };
  if (product.sizeBytes > COMPARISON_MAX_BYTES) {
    summary.inspectionUnavailableReason =
      'Sequence is too large for inline inspection. Compare the sequence files before choosing.';
    return summary;
  }
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(
      await readComparisonBytes(product)
    );
    if (
      !/^LOCUS\b/m.test(content) ||
      !/^\/\/\s*$/m.test(content) ||
      parseGenBankRecords(content).length !== 1
    ) {
      throw new Error('Expected one complete GenBank record.');
    }
    const sequence = parseGenBankFull(content, { featurePolicy: 'preserve' });
    summary.baseCount = sequence.sequence.length;
    summary.topology = sequence.circular ? 'circular' : 'linear';
    summary.basesSha256 = hash(sequence.sequence);
    summary.annotationsSha256 = hash(JSON.stringify(sequence.annotations));
    summary.annotationCount = sequence.annotations.length;
    summary.annotationNames = sequence.annotations
      .slice(0, COMPARISON_MAX_LABELS)
      .map(
        (feature) =>
          `${(feature.name || feature.type).slice(0, 120)} (${feature.type}, ${feature.start}–${feature.end}${feature.direction === -1 ? ', reverse' : ''})`
      );
  } catch {
    summary.inspectionUnavailableReason =
      'The exact saved sequence bytes could not be inspected. Compare the sequence files before choosing.';
  }
  return summary;
}

async function readComparisonBytes(file: WorkspaceSyncFile): Promise<Uint8Array> {
  if (file.sizeBytes > COMPARISON_MAX_BYTES) throw new Error('Comparison display bound exceeded.');
  return readVerifiedWorkspaceSyncFile(file);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
