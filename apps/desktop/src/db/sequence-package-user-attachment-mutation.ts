import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../shared/workspace-file-atomic';
import {
  SEQUENCE_PACKAGE_PAYLOAD_DIR,
  containsSequencePackageControlCharacters,
  sequenceManagedMemberPath,
  type SequencePackageDocument,
  type SequencePackageMember,
} from './sequence-package';

export interface PreparedUserAttachmentAsset {
  memberId: string;
  path: string;
  sha256: string;
  content: Uint8Array;
}

export interface PreparedUserAttachmentMutation {
  nextDocument: SequencePackageDocument;
  asset: PreparedUserAttachmentAsset | null;
}

export type UserAttachmentMutation =
  | {
      kind: 'attach' | 'replace';
      attachmentId: string;
      memberId: string;
      fileName: string;
      content: Uint8Array;
      mediaType?: string;
      createdAt: string;
    }
  | {
      kind: 'detach';
      attachmentId: string;
      createdAt: string;
    };

export async function prepareSequenceUserAttachmentMutation(
  document: SequencePackageDocument,
  mutation: UserAttachmentMutation
): Promise<PreparedUserAttachmentMutation> {
  assertAttachmentId(mutation.attachmentId);
  if (!mutation.createdAt || !Number.isFinite(Date.parse(mutation.createdAt))) {
    throw new Error('User attachment mutation requires a valid creation time.');
  }
  const existing = Object.prototype.hasOwnProperty.call(
    document.userAttachments,
    mutation.attachmentId
  );
  if (mutation.kind === 'attach' && existing) {
    throw new Error('The logical user attachment already exists; replace it explicitly.');
  }
  if (mutation.kind !== 'attach' && !existing) {
    throw new Error('The logical user attachment no longer exists. Reopen and review it.');
  }

  const nextDocument = structuredClone(document);
  nextDocument.updatedAt = mutation.createdAt;
  if (mutation.kind === 'detach') {
    delete nextDocument.userAttachments[mutation.attachmentId];
    return { nextDocument, asset: null };
  }

  assertMemberId(mutation.memberId);
  assertAttachmentFileName(mutation.fileName);
  if (!(mutation.content instanceof Uint8Array)) {
    throw new Error('User attachment content must be binary bytes.');
  }
  if (mutation.content.byteLength > MAX_WORKSPACE_BINARY_WRITE_BYTES) {
    throw new Error(
      `User attachment exceeds ${MAX_WORKSPACE_BINARY_WRITE_BYTES} bytes per operation.`
    );
  }
  if (
    mutation.mediaType !== undefined &&
    (!mutation.mediaType ||
      mutation.mediaType.length > 256 ||
      containsSequencePackageControlCharacters(mutation.mediaType))
  ) {
    throw new Error('User attachment media type is invalid.');
  }
  const path = sequenceManagedMemberPath(
    `user-attachment-${mutation.memberId}-${mutation.fileName}`
  );
  if (document.members.some((member) => member.id === mutation.memberId || member.path === path)) {
    throw new Error('The immutable user member identity or path already exists.');
  }
  const content = new Uint8Array(mutation.content);
  const sha256 = await sha256Bytes(content);
  const member: SequencePackageMember = {
    id: mutation.memberId,
    role: 'user',
    path,
    replaceable: false,
    createdAt: mutation.createdAt,
    ...(mutation.mediaType ? { mediaType: mutation.mediaType } : {}),
  };
  nextDocument.members.push(member);
  nextDocument.userAttachments[mutation.attachmentId] = {
    memberId: member.id,
    sha256,
  };
  return {
    nextDocument,
    asset: { memberId: member.id, path, sha256, content },
  };
}

export async function verifyPreparedUserAttachmentAsset(
  asset: PreparedUserAttachmentAsset
): Promise<void> {
  assertMemberId(asset.memberId);
  const prefix = `${SEQUENCE_PACKAGE_PAYLOAD_DIR}/user-attachment-${asset.memberId}-`;
  if (!asset.path.startsWith(prefix)) {
    throw new Error('User attachment asset is outside its package-owned member path.');
  }
  assertAttachmentFileName(asset.path.slice(prefix.length));
  if (!(asset.content instanceof Uint8Array)) {
    throw new Error('User attachment asset has no binary bytes.');
  }
  if (asset.content.byteLength > MAX_WORKSPACE_BINARY_WRITE_BYTES) {
    throw new Error('User attachment asset exceeds the bounded binary write size.');
  }
  if ((await sha256Bytes(asset.content)) !== asset.sha256) {
    throw new Error('User attachment asset bytes do not match their SHA-256 pin.');
  }
}

function assertAttachmentId(value: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > 256 ||
    containsSequencePackageControlCharacters(value) ||
    ['__proto__', 'prototype', 'constructor'].includes(value)
  ) {
    throw new Error('Logical user attachment identity is invalid.');
  }
}

function assertMemberId(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  ) {
    throw new Error('User member ID must be a stable UUID.');
  }
}

function assertAttachmentFileName(value: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.length > 180 ||
    /[<>:"/\\|?*]/.test(value) ||
    containsSequencePackageControlCharacters(value) ||
    /[. ]$/.test(value)
  ) {
    throw new Error('User attachment file name is unsafe or too long.');
  }
}

async function sha256Bytes(content: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', content);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}
