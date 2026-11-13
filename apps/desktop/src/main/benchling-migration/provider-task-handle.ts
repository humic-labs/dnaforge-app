import { createHash } from 'node:crypto';

import type {
  DirectFolderExportAuthority,
  FolderTreeExportAuthority,
  SourceBinding,
} from '../../shared/benchling-migration';
import { hasCanonicalBenchlingItemUrl } from './canonical-item-url';

export const PROVIDER_TASK_HANDLE_SCHEMA = 'dnaforge.benchling.provider-task-handle.v1' as const;

const PROVIDER_TASK_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const PROVIDER_TASK_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PROVIDER_TASK_RECEIPT = /^provider-task:[a-f0-9]{64}$/u;
const DIRECT_FOLDER_ID = /^lib_[A-Za-z0-9]+$/u;
const DIRECT_FOLDER_NOTEBOOK_ENTRY_ID = /^(?:etr|entry)_[A-Za-z0-9]+$/u;
const DIRECT_FOLDER_SEQUENCE_ID = /^seq_[A-Za-z0-9]+$/u;
const DIRECT_FOLDER_AUTHORITY_SCHEMA =
  'dnaforge.benchling.direct-folder-export-authority.v1' as const;
const DIRECT_FOLDER_AUTHORITY_DIGEST_SCHEMA =
  'dnaforge.benchling.direct-folder-export-authority-digest.v1' as const;
const DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY = 'benchling.notebook-entry-html-export.v1' as const;
const DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY =
  'benchling.sequence-single-file-export.v1' as const;

export function directFolderAuthorityDigest(authority: DirectFolderExportAuthority): string {
  const exactKeys = [
    'schema',
    'capturePlanDigest',
    'traversalJournalDigest',
    'selectedRootId',
    'sourceItemId',
    'sourceItemUrl',
    'sourceItemType',
    'sourceFolderIds',
    'requestCapabilityId',
  ];
  if (
    !authority ||
    typeof authority !== 'object' ||
    Object.keys(authority).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.prototype.hasOwnProperty.call(authority, key)) ||
    authority.schema !== DIRECT_FOLDER_AUTHORITY_SCHEMA ||
    !SHA256.test(authority.capturePlanDigest) ||
    !SHA256.test(authority.traversalJournalDigest) ||
    !DIRECT_FOLDER_ID.test(authority.selectedRootId) ||
    authority.sourceItemId === authority.selectedRootId ||
    !hasCanonicalBenchlingItemUrl(authority.sourceItemUrl, authority.sourceItemId) ||
    !Array.isArray(authority.sourceFolderIds) ||
    authority.sourceFolderIds.length !== 1 ||
    Object.keys(authority.sourceFolderIds).length !== 1 ||
    authority.sourceFolderIds[0] !== authority.selectedRootId ||
    !isExactDirectFolderItemAuthority(authority)
  ) {
    throw new Error('Direct Folder export authority is invalid.');
  }
  const canonical = JSON.stringify({
    schema: DIRECT_FOLDER_AUTHORITY_DIGEST_SCHEMA,
    authority: {
      schema: DIRECT_FOLDER_AUTHORITY_SCHEMA,
      capturePlanDigest: authority.capturePlanDigest,
      traversalJournalDigest: authority.traversalJournalDigest,
      selectedRootId: authority.selectedRootId,
      sourceItemId: authority.sourceItemId,
      sourceItemUrl: authority.sourceItemUrl,
      sourceItemType: authority.sourceItemType,
      sourceFolderIds: [authority.selectedRootId],
      requestCapabilityId: authority.requestCapabilityId,
    },
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function isExactDirectFolderItemAuthority(authority: DirectFolderExportAuthority): boolean {
  return (
    (authority.sourceItemType === 'entry' &&
      DIRECT_FOLDER_NOTEBOOK_ENTRY_ID.test(authority.sourceItemId) &&
      authority.requestCapabilityId === DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY) ||
    (authority.sourceItemType === 'sequence' &&
      DIRECT_FOLDER_SEQUENCE_ID.test(authority.sourceItemId) &&
      authority.requestCapabilityId === DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY)
  );
}

export function folderTreeAuthorityDigest(authority: FolderTreeExportAuthority): string {
  const exactKeys = [
    'schema',
    'capturePlanDigest',
    'traversalJournalDigest',
    'selectedRootId',
    'sourceItemId',
    'sourceItemUrl',
    'sourceItemType',
    'sourceFolderIds',
    'maximumFolderDepth',
    'requestCapabilityId',
  ];
  if (
    !authority ||
    typeof authority !== 'object' ||
    Object.keys(authority).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.prototype.hasOwnProperty.call(authority, key)) ||
    authority.schema !== 'dnaforge.benchling.folder-tree-export-authority.v1' ||
    !SHA256.test(authority.capturePlanDigest) ||
    !SHA256.test(authority.traversalJournalDigest) ||
    !/^(?:fld|lib|src)_[A-Za-z0-9]+$/u.test(authority.selectedRootId) ||
    !hasCanonicalBenchlingItemUrl(authority.sourceItemUrl, authority.sourceItemId) ||
    !isExactFolderTreeItemAuthority(authority) ||
    !Array.isArray(authority.sourceFolderIds) ||
    authority.sourceFolderIds.length === 0 ||
    Object.keys(authority.sourceFolderIds).length !== authority.sourceFolderIds.length ||
    authority.sourceFolderIds.some((id) => !/^(?:fld|lib|src)_[A-Za-z0-9]+$/u.test(id)) ||
    new Set(authority.sourceFolderIds).size !== authority.sourceFolderIds.length ||
    JSON.stringify(authority.sourceFolderIds) !==
      JSON.stringify([...authority.sourceFolderIds].sort()) ||
    !Number.isSafeInteger(authority.maximumFolderDepth) ||
    authority.maximumFolderDepth < 0 ||
    authority.maximumFolderDepth > 100_000
  ) {
    throw new Error('Folder Tree export authority is invalid.');
  }
  const canonical = JSON.stringify({
    schema: 'dnaforge.benchling.folder-tree-export-authority-digest.v1',
    authority: {
      schema: 'dnaforge.benchling.folder-tree-export-authority.v1',
      capturePlanDigest: authority.capturePlanDigest,
      traversalJournalDigest: authority.traversalJournalDigest,
      selectedRootId: authority.selectedRootId,
      sourceItemId: authority.sourceItemId,
      sourceItemUrl: authority.sourceItemUrl,
      sourceItemType: authority.sourceItemType,
      sourceFolderIds: [...authority.sourceFolderIds],
      maximumFolderDepth: authority.maximumFolderDepth,
      requestCapabilityId: authority.requestCapabilityId,
    },
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function isExactFolderTreeItemAuthority(authority: FolderTreeExportAuthority): boolean {
  return (
    (authority.sourceItemType === 'entry' &&
      DIRECT_FOLDER_NOTEBOOK_ENTRY_ID.test(authority.sourceItemId) &&
      authority.requestCapabilityId === DIRECT_FOLDER_NOTEBOOK_EXPORT_CAPABILITY) ||
    (authority.sourceItemType === 'sequence' &&
      DIRECT_FOLDER_SEQUENCE_ID.test(authority.sourceItemId) &&
      authority.requestCapabilityId === DIRECT_FOLDER_SEQUENCE_EXPORT_CAPABILITY)
  );
}

export function providerTaskHandleHash(input: {
  binding: Pick<SourceBinding, 'benchlingOrigin' | 'benchlingOrganizationId'>;
  providerTaskId: string;
  jobId: string;
  matchSignature: string;
  directFolderAuthorityDigest?: string | null;
  folderTreeAuthorityDigest?: string | null;
}): string {
  if (!PROVIDER_TASK_OPAQUE_ID.test(input.providerTaskId)) {
    throw new Error('Provider task handle requires an allowlisted task identity.');
  }
  const providerTaskId = PROVIDER_TASK_UUID.test(input.providerTaskId)
    ? input.providerTaskId.toLowerCase()
    : input.providerTaskId;
  const directFolderDigest = input.directFolderAuthorityDigest ?? null;
  const folderTreeDigest = input.folderTreeAuthorityDigest ?? null;
  if (directFolderDigest !== null && !SHA256.test(directFolderDigest)) {
    throw new Error('Direct Folder authority digest is invalid.');
  }
  if (folderTreeDigest !== null && !SHA256.test(folderTreeDigest)) {
    throw new Error('Folder Tree authority digest is invalid.');
  }
  if (directFolderDigest !== null && folderTreeDigest !== null) {
    throw new Error('Provider task handle cannot carry two selected-scope authorities.');
  }
  const canonical = JSON.stringify({
    schema: PROVIDER_TASK_HANDLE_SCHEMA,
    tenantOrigin: input.binding.benchlingOrigin,
    tenantId: input.binding.benchlingOrganizationId,
    providerTaskId,
    jobId: input.jobId,
    matchSignature: input.matchSignature,
    ...(directFolderDigest === null ? {} : { directFolderAuthorityDigest: directFolderDigest }),
    ...(folderTreeDigest === null ? {} : { folderTreeAuthorityDigest: folderTreeDigest }),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function assertProviderTaskHandleSha256(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error('Provider task handle digest is invalid.');
  }
}

export function providerTaskReceiptId(providerTaskHandleSha256: string): string {
  assertProviderTaskHandleSha256(providerTaskHandleSha256);
  return `provider-task:${providerTaskHandleSha256.slice('sha256:'.length)}`;
}

export function assertProviderTaskReceiptId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PROVIDER_TASK_RECEIPT.test(value)) {
    throw new Error('Provider task receipt ID is invalid.');
  }
}
