import { createHash } from 'node:crypto';
import { DEFAULT_SHARE_BUNDLE_LIMITS, isSafeRelativePath, type ShareBundleLimits } from './shared';

export const DEEP_SHARE_SCHEMA = 'dnaforge.deep-share/v1' as const;

export const DEEP_SHARE_ARTIFACT_TYPES = [
  'sequence',
  'primer',
  'notebook',
  'design',
  'alignment',
  'trace',
  'report',
  'construct',
  'sample',
  'selection',
  'structure',
  'protein',
  'protocol',
  'protocol_run',
  'file',
  'folder',
] as const;

export type DeepShareArtifactType = (typeof DEEP_SHARE_ARTIFACT_TYPES)[number];

export const DEEP_SHARE_RELATIONS = [
  'produces',
  'assembled_from',
  'revision_of',
  'derived_from',
  'binds_to_sequence',
  'references',
] as const;

export type DeepShareRelation = (typeof DEEP_SHARE_RELATIONS)[number];

export const DEEP_SHARE_OMISSION_CODES = [
  'UNSUPPORTED_RELATION',
  'UNRESOLVED_TARGET',
  'UNCONFIRMED_RELATION',
  'UNSUPPORTED_FILE',
  'FILE_TOO_LARGE',
  'CHAT_FIELD_EXCLUDED',
] as const;

export type DeepShareOmissionCode = (typeof DEEP_SHARE_OMISSION_CODES)[number];

export interface DeepShareArtifactRef {
  id: string;
  type: DeepShareArtifactType;
  name: string;
}

export interface DeepShareManifestArtifact extends DeepShareArtifactRef {
  required: boolean;
}

export interface DeepShareRelationshipV1 {
  sourceArtifactId: string;
  relation: DeepShareRelation;
  targetArtifactId: string;
}

export interface DeepShareManifestFile {
  fileId: string;
  ownerArtifactId: string;
  role: string;
}

export interface DeepShareManifestChat {
  conversationId: string;
  title: string;
}

export interface DeepShareOmission {
  code: DeepShareOmissionCode;
  subject: string;
  detail: string;
}

export interface DeepShareManifestV1 {
  rootArtifactId: string;
  artifacts: DeepShareManifestArtifact[];
  relationships: DeepShareRelationshipV1[];
  files: DeepShareManifestFile[];
  chats: DeepShareManifestChat[];
  omissions: DeepShareOmission[];
}

export type DeepShareFileContent =
  | { encoding: 'utf8'; text: string }
  | { encoding: 'base64'; data: string };

export interface DeepShareFileV1 {
  id: string;
  ownerArtifactId: string;
  relativePath: string;
  name: string;
  role: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  content: DeepShareFileContent;
}

export interface PortableChatReferenceV1 {
  artifactId: string;
  artifactType: DeepShareArtifactType;
  label: string;
}

export interface PortableChatMessageV1 {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  references: PortableChatReferenceV1[];
}

export interface PortableConversationV1 {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: PortableChatMessageV1[];
}

export interface DeepShareParentRef {
  shareId: string;
  sourceArtifactId: string;
  bundleContentSha256: string;
}

export interface DeepShareBundleV1 {
  schema: typeof DEEP_SHARE_SCHEMA;
  appVersion: string;
  createdAt: string;
  source: {
    workspaceId: string;
    workspaceName: string;
    artifact: DeepShareArtifactRef;
    pinnedVersionId: string;
    pinnedVersionNumber: number;
    pinnedVersionContentSha256: string;
  };
  parent: DeepShareParentRef | null;
  manifest: DeepShareManifestV1;
  files: DeepShareFileV1[];
  chats: PortableConversationV1[];
  limits: ShareBundleLimits;
  contentSha256: string;
}

export type DeepShareBundleV1Input = Omit<DeepShareBundleV1, 'contentSha256'>;

export type DeepShareBundleValidationResult =
  | { ok: true; bundle: DeepShareBundleV1 }
  | { ok: false; errors: string[] };

export function createDeepShareBundleV1(input: DeepShareBundleV1Input): DeepShareBundleV1 {
  const unhashed: DeepShareBundleV1 = { ...input, contentSha256: '' };
  return {
    ...input,
    contentSha256: sha256Utf8(deepShareBundleHashInput(unhashed)),
  };
}

export function deepShareBundleHashInput(bundle: DeepShareBundleV1): string {
  return stableJsonStringify({
    ...bundle,
    createdAt: '',
    contentSha256: '',
    manifest: {
      ...bundle.manifest,
      artifacts: [...bundle.manifest.artifacts].sort(compareBy((item) => item.id)),
      relationships: [...bundle.manifest.relationships].sort(
        compareBy(
          (item) => `${item.sourceArtifactId}\u0000${item.relation}\u0000${item.targetArtifactId}`
        )
      ),
      files: [...bundle.manifest.files].sort(compareBy((item) => item.fileId)),
      chats: [...bundle.manifest.chats].sort(compareBy((item) => item.conversationId)),
      omissions: [...bundle.manifest.omissions].sort(
        compareBy((item) => `${item.code}\u0000${item.subject}\u0000${item.detail}`)
      ),
    },
    files: [...bundle.files].sort(compareBy((item) => item.relativePath)),
    chats: [...bundle.chats].sort(compareBy((item) => item.id)).map((chat) => ({
      ...chat,
      messages: chat.messages.map((message) => ({
        ...message,
        references: [...message.references].sort(compareBy((item) => item.artifactId)),
      })),
    })),
  });
}

export function validateDeepShareBundleV1(value: unknown): DeepShareBundleValidationResult {
  const errors: string[] = [];
  const bundle = parseBundle(value, errors);
  if (!bundle) return { ok: false, errors };

  validateBundleReferences(bundle, errors);
  validateBundleFiles(bundle, errors);
  validateBundleChat(bundle, errors);

  const actualHash = sha256Utf8(deepShareBundleHashInput(bundle));
  if (bundle.contentSha256 !== actualHash) {
    errors.push('contentSha256 does not match bundle');
  }

  return errors.length === 0 ? { ok: true, bundle } : { ok: false, errors };
}

function parseBundle(value: unknown, errors: string[]): DeepShareBundleV1 | null {
  const input = requireRecord(value, 'bundle', errors);
  if (!input) return null;
  rejectExtraFields(
    input,
    [
      'schema',
      'appVersion',
      'createdAt',
      'source',
      'parent',
      'manifest',
      'files',
      'chats',
      'limits',
      'contentSha256',
    ],
    'bundle',
    errors
  );

  const schema = input.schema;
  if (schema !== DEEP_SHARE_SCHEMA) errors.push(`schema must be ${DEEP_SHARE_SCHEMA}`);
  const appVersion = requireText(input.appVersion, 'appVersion', errors);
  const createdAt = requireTimestamp(input.createdAt, 'createdAt', errors);
  const source = parseSource(input.source, errors);
  const parent = parseParent(input.parent, errors);
  const manifest = parseManifest(input.manifest, errors);
  const files = parseArray(input.files, 'files', errors, parseFile);
  const chats = parseArray(input.chats, 'chats', errors, parseChat);
  const limits = parseLimits(input.limits, errors);
  const contentSha256 = requireSha256(input.contentSha256, 'contentSha256', errors);

  if (
    schema !== DEEP_SHARE_SCHEMA ||
    !appVersion ||
    !createdAt ||
    !source ||
    parent === undefined ||
    !manifest ||
    !files ||
    !chats ||
    !limits ||
    !contentSha256
  ) {
    return null;
  }

  return {
    schema,
    appVersion,
    createdAt,
    source,
    parent,
    manifest,
    files,
    chats,
    limits,
    contentSha256,
  };
}

function parseSource(value: unknown, errors: string[]): DeepShareBundleV1['source'] | null {
  const input = requireRecord(value, 'source', errors);
  if (!input) return null;
  rejectExtraFields(
    input,
    [
      'workspaceId',
      'workspaceName',
      'artifact',
      'pinnedVersionId',
      'pinnedVersionNumber',
      'pinnedVersionContentSha256',
    ],
    'source',
    errors
  );
  const workspaceId = requireId(input.workspaceId, 'source.workspaceId', errors);
  const workspaceName = requireText(input.workspaceName, 'source.workspaceName', errors);
  const artifact = parseArtifactRef(input.artifact, 'source.artifact', errors);
  const pinnedVersionId = requireId(input.pinnedVersionId, 'source.pinnedVersionId', errors);
  const pinnedVersionNumber = requirePositiveInteger(
    input.pinnedVersionNumber,
    'source.pinnedVersionNumber',
    errors
  );
  const pinnedVersionContentSha256 = requireSha256(
    input.pinnedVersionContentSha256,
    'source.pinnedVersionContentSha256',
    errors
  );
  if (
    !workspaceId ||
    !workspaceName ||
    !artifact ||
    !pinnedVersionId ||
    pinnedVersionNumber === null ||
    !pinnedVersionContentSha256
  ) {
    return null;
  }
  return {
    workspaceId,
    workspaceName,
    artifact,
    pinnedVersionId,
    pinnedVersionNumber,
    pinnedVersionContentSha256,
  };
}

function parseParent(value: unknown, errors: string[]): DeepShareParentRef | null | undefined {
  if (value === null) return null;
  const input = requireRecord(value, 'parent', errors);
  if (!input) return undefined;
  rejectExtraFields(
    input,
    ['shareId', 'sourceArtifactId', 'bundleContentSha256'],
    'parent',
    errors
  );
  const shareId = requireId(input.shareId, 'parent.shareId', errors);
  const sourceArtifactId = requireId(input.sourceArtifactId, 'parent.sourceArtifactId', errors);
  const bundleContentSha256 = requireSha256(
    input.bundleContentSha256,
    'parent.bundleContentSha256',
    errors
  );
  if (!shareId || !sourceArtifactId || !bundleContentSha256) return undefined;
  return { shareId, sourceArtifactId, bundleContentSha256 };
}

function parseManifest(value: unknown, errors: string[]): DeepShareManifestV1 | null {
  const input = requireRecord(value, 'manifest', errors);
  if (!input) return null;
  rejectExtraFields(
    input,
    ['rootArtifactId', 'artifacts', 'relationships', 'files', 'chats', 'omissions'],
    'manifest',
    errors
  );
  const rootArtifactId = requireId(input.rootArtifactId, 'manifest.rootArtifactId', errors);
  const artifacts = parseArray(
    input.artifacts,
    'manifest.artifacts',
    errors,
    parseManifestArtifact
  );
  const relationships = parseArray(
    input.relationships,
    'manifest.relationships',
    errors,
    parseRelationship
  );
  const files = parseArray(input.files, 'manifest.files', errors, parseManifestFile);
  const chats = parseArray(input.chats, 'manifest.chats', errors, parseManifestChat);
  const omissions = parseArray(input.omissions, 'manifest.omissions', errors, parseOmission);
  if (!rootArtifactId || !artifacts || !relationships || !files || !chats || !omissions) {
    return null;
  }
  return { rootArtifactId, artifacts, relationships, files, chats, omissions };
}

function parseArtifactRef(
  value: unknown,
  label: string,
  errors: string[]
): DeepShareArtifactRef | null {
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['id', 'type', 'name'], label, errors);
  const id = requireId(input.id, `${label}.id`, errors);
  const type = requireLiteral(input.type, DEEP_SHARE_ARTIFACT_TYPES, `${label}.type`, errors);
  const name = requireText(input.name, `${label}.name`, errors);
  return id && type && name ? { id, type, name } : null;
}

function parseManifestArtifact(
  value: unknown,
  index: number,
  errors: string[]
): DeepShareManifestArtifact | null {
  const label = `manifest.artifacts[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['id', 'type', 'name', 'required'], label, errors);
  const id = requireId(input.id, `${label}.id`, errors);
  const type = requireLiteral(input.type, DEEP_SHARE_ARTIFACT_TYPES, `${label}.type`, errors);
  const name = requireText(input.name, `${label}.name`, errors);
  const required = requireBoolean(input.required, `${label}.required`, errors);
  return id && type && name && required !== null ? { id, type, name, required } : null;
}

function parseRelationship(
  value: unknown,
  index: number,
  errors: string[]
): DeepShareRelationshipV1 | null {
  const label = `manifest.relationships[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['sourceArtifactId', 'relation', 'targetArtifactId'], label, errors);
  const sourceArtifactId = requireId(input.sourceArtifactId, `${label}.sourceArtifactId`, errors);
  const relation = requireLiteral(
    input.relation,
    DEEP_SHARE_RELATIONS,
    `${label}.relation`,
    errors
  );
  const targetArtifactId = requireId(input.targetArtifactId, `${label}.targetArtifactId`, errors);
  return sourceArtifactId && relation && targetArtifactId
    ? { sourceArtifactId, relation, targetArtifactId }
    : null;
}

function parseManifestFile(
  value: unknown,
  index: number,
  errors: string[]
): DeepShareManifestFile | null {
  const label = `manifest.files[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['fileId', 'ownerArtifactId', 'role'], label, errors);
  const fileId = requireId(input.fileId, `${label}.fileId`, errors);
  const ownerArtifactId = requireId(input.ownerArtifactId, `${label}.ownerArtifactId`, errors);
  const role = requireText(input.role, `${label}.role`, errors);
  return fileId && ownerArtifactId && role ? { fileId, ownerArtifactId, role } : null;
}

function parseManifestChat(
  value: unknown,
  index: number,
  errors: string[]
): DeepShareManifestChat | null {
  const label = `manifest.chats[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['conversationId', 'title'], label, errors);
  const conversationId = requireId(input.conversationId, `${label}.conversationId`, errors);
  const title = requireText(input.title, `${label}.title`, errors);
  return conversationId && title ? { conversationId, title } : null;
}

function parseOmission(value: unknown, index: number, errors: string[]): DeepShareOmission | null {
  const label = `manifest.omissions[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['code', 'subject', 'detail'], label, errors);
  const code = requireLiteral(input.code, DEEP_SHARE_OMISSION_CODES, `${label}.code`, errors);
  const subject = requireText(input.subject, `${label}.subject`, errors);
  const detail = requireText(input.detail, `${label}.detail`, errors);
  return code && subject && detail ? { code, subject, detail } : null;
}

function parseFile(value: unknown, index: number, errors: string[]): DeepShareFileV1 | null {
  const label = `files[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(
    input,
    [
      'id',
      'ownerArtifactId',
      'relativePath',
      'name',
      'role',
      'contentType',
      'sizeBytes',
      'sha256',
      'content',
    ],
    label,
    errors
  );
  const id = requireId(input.id, `${label}.id`, errors);
  const ownerArtifactId = requireId(input.ownerArtifactId, `${label}.ownerArtifactId`, errors);
  const relativePath = requireText(input.relativePath, `${label}.relativePath`, errors);
  const name = requireText(input.name, `${label}.name`, errors);
  const role = requireText(input.role, `${label}.role`, errors);
  const contentType = requireText(input.contentType, `${label}.contentType`, errors);
  const sizeBytes = requireNonNegativeInteger(input.sizeBytes, `${label}.sizeBytes`, errors);
  const sha256 = requireSha256(input.sha256, `${label}.sha256`, errors);
  const content = parseFileContent(input.content, `${label}.content`, errors);
  if (
    !id ||
    !ownerArtifactId ||
    !relativePath ||
    !name ||
    !role ||
    !contentType ||
    sizeBytes === null ||
    !sha256 ||
    !content
  ) {
    return null;
  }
  return {
    id,
    ownerArtifactId,
    relativePath,
    name,
    role,
    contentType,
    sizeBytes,
    sha256,
    content,
  };
}

function parseFileContent(
  value: unknown,
  label: string,
  errors: string[]
): DeepShareFileContent | null {
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  if (input.encoding === 'utf8') {
    rejectExtraFields(input, ['encoding', 'text'], label, errors);
    const text = requireString(input.text, `${label}.text`, errors);
    return text === null ? null : { encoding: 'utf8', text };
  }
  if (input.encoding === 'base64') {
    rejectExtraFields(input, ['encoding', 'data'], label, errors);
    const data = requireString(input.data, `${label}.data`, errors);
    if (data === null) return null;
    if (!isCanonicalBase64(data)) {
      errors.push(`${label}.data must be canonical base64`);
      return null;
    }
    return { encoding: 'base64', data };
  }
  errors.push(`${label}.encoding is unsupported`);
  return null;
}

function parseChat(value: unknown, index: number, errors: string[]): PortableConversationV1 | null {
  const label = `chats[${index}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['id', 'title', 'createdAt', 'updatedAt', 'messages'], label, errors);
  const id = requireId(input.id, `${label}.id`, errors);
  const title = requireText(input.title, `${label}.title`, errors);
  const createdAt = requireTimestamp(input.createdAt, `${label}.createdAt`, errors);
  const updatedAt = requireTimestamp(input.updatedAt, `${label}.updatedAt`, errors);
  const messages = parseArray(
    input.messages,
    `${label}.messages`,
    errors,
    (entry, messageIndex, xs) => parseMessage(entry, index, messageIndex, xs)
  );
  return id && title && createdAt && updatedAt && messages
    ? { id, title, createdAt, updatedAt, messages }
    : null;
}

function parseMessage(
  value: unknown,
  chatIndex: number,
  messageIndex: number,
  errors: string[]
): PortableChatMessageV1 | null {
  const label = `chats[${chatIndex}].messages[${messageIndex}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['id', 'role', 'content', 'createdAt', 'references'], label, errors);
  const id = requireId(input.id, `${label}.id`, errors);
  const role = requireLiteral(input.role, ['user', 'assistant'], `${label}.role`, errors);
  const content = requireString(input.content, `${label}.content`, errors);
  const createdAt = requireTimestamp(input.createdAt, `${label}.createdAt`, errors);
  const references = parseArray(
    input.references,
    `${label}.references`,
    errors,
    (entry, referenceIndex, xs) =>
      parseReference(entry, chatIndex, messageIndex, referenceIndex, xs)
  );
  return id && role && content !== null && createdAt && references
    ? { id, role, content, createdAt, references }
    : null;
}

function parseReference(
  value: unknown,
  chatIndex: number,
  messageIndex: number,
  referenceIndex: number,
  errors: string[]
): PortableChatReferenceV1 | null {
  const label = `chats[${chatIndex}].messages[${messageIndex}].references[${referenceIndex}]`;
  const input = requireRecord(value, label, errors);
  if (!input) return null;
  rejectExtraFields(input, ['artifactId', 'artifactType', 'label'], label, errors);
  const artifactId = requireId(input.artifactId, `${label}.artifactId`, errors);
  const artifactType = requireLiteral(
    input.artifactType,
    DEEP_SHARE_ARTIFACT_TYPES,
    `${label}.artifactType`,
    errors
  );
  const displayLabel = requireText(input.label, `${label}.label`, errors);
  return artifactId && artifactType && displayLabel
    ? { artifactId, artifactType, label: displayLabel }
    : null;
}

function parseLimits(value: unknown, errors: string[]): ShareBundleLimits | null {
  const input = requireRecord(value, 'limits', errors);
  if (!input) return null;
  rejectExtraFields(input, ['maxFileBytes', 'maxBundleBytes', 'maxFiles'], 'limits', errors);
  const maxFileBytes = requirePositiveInteger(input.maxFileBytes, 'limits.maxFileBytes', errors);
  const maxBundleBytes = requirePositiveInteger(
    input.maxBundleBytes,
    'limits.maxBundleBytes',
    errors
  );
  const maxFiles = requirePositiveInteger(input.maxFiles, 'limits.maxFiles', errors);
  if (maxFileBytes === null || maxBundleBytes === null || maxFiles === null) return null;
  return { maxFileBytes, maxBundleBytes, maxFiles };
}

function validateBundleReferences(bundle: DeepShareBundleV1, errors: string[]): void {
  const artifactIds = new Set<string>();
  for (const [index, artifact] of bundle.manifest.artifacts.entries()) {
    if (artifactIds.has(artifact.id)) errors.push(`manifest.artifacts[${index}].id is duplicated`);
    artifactIds.add(artifact.id);
  }
  if (!artifactIds.has(bundle.manifest.rootArtifactId)) {
    errors.push('manifest.rootArtifactId is not included');
  }
  const root = bundle.manifest.artifacts.find(
    (artifact) => artifact.id === bundle.manifest.rootArtifactId
  );
  if (root && !root.required) errors.push('manifest root artifact must be required');
  if (bundle.source.artifact.id !== bundle.manifest.rootArtifactId) {
    errors.push('source.artifact.id must match manifest.rootArtifactId');
  }

  for (const [index, relationship] of bundle.manifest.relationships.entries()) {
    if (!artifactIds.has(relationship.sourceArtifactId)) {
      errors.push(`manifest.relationships[${index}].sourceArtifactId is not included`);
    }
    if (!artifactIds.has(relationship.targetArtifactId)) {
      errors.push(`manifest.relationships[${index}].targetArtifactId is not included`);
    }
  }

  const fileIds = uniqueIds(bundle.files, 'files', errors);
  const manifestFileIds = new Set<string>();
  for (const [index, file] of bundle.manifest.files.entries()) {
    if (manifestFileIds.has(file.fileId)) {
      errors.push(`manifest.files[${index}].fileId is duplicated`);
    }
    manifestFileIds.add(file.fileId);
    if (!fileIds.has(file.fileId)) errors.push(`manifest.files[${index}].fileId is not included`);
    if (!artifactIds.has(file.ownerArtifactId)) {
      errors.push(`manifest.files[${index}].ownerArtifactId is not included`);
    }
  }
  for (const [index, file] of bundle.files.entries()) {
    if (!manifestFileIds.has(file.id)) errors.push(`files[${index}].id is missing from manifest`);
    if (!artifactIds.has(file.ownerArtifactId)) {
      errors.push(`files[${index}].ownerArtifactId is not included`);
    }
  }

  const chatIds = uniqueIds(bundle.chats, 'chats', errors);
  const manifestChatIds = new Set<string>();
  for (const [index, chat] of bundle.manifest.chats.entries()) {
    if (manifestChatIds.has(chat.conversationId)) {
      errors.push(`manifest.chats[${index}].conversationId is duplicated`);
    }
    manifestChatIds.add(chat.conversationId);
    if (!chatIds.has(chat.conversationId)) {
      errors.push(`manifest.chats[${index}].conversationId is not included`);
    }
  }
  for (const [index, chat] of bundle.chats.entries()) {
    if (!manifestChatIds.has(chat.id)) errors.push(`chats[${index}].id is missing from manifest`);
  }
}

function validateBundleFiles(bundle: DeepShareBundleV1, errors: string[]): void {
  const normalizedPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  let totalBytes = 0;

  if (
    bundle.files.length > Math.min(bundle.limits.maxFiles, DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles)
  ) {
    errors.push(`files must contain at most ${DEFAULT_SHARE_BUNDLE_LIMITS.maxFiles} entries`);
  }
  for (const [index, file] of bundle.files.entries()) {
    if (!isSafeRelativePath(file.relativePath)) {
      errors.push(`files[${index}].relativePath is unsafe`);
    } else {
      const normalized = file.relativePath.replace(/\\/gu, '/');
      if (normalizedPaths.has(normalized)) {
        errors.push(`files[${index}].relativePath is duplicated`);
      }
      normalizedPaths.add(normalized);
      const caseFolded = normalized.toLocaleLowerCase('en-US');
      if (caseFoldedPaths.has(caseFolded)) {
        errors.push(`files[${index}].relativePath collides case-insensitively`);
      }
      caseFoldedPaths.add(caseFolded);
    }

    const bytes = decodeFileContent(file.content);
    totalBytes += bytes.byteLength;
    if (file.sizeBytes !== bytes.byteLength) {
      errors.push(`files[${index}].sizeBytes does not match decoded content`);
    }
    if (
      bytes.byteLength >
      Math.min(bundle.limits.maxFileBytes, DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes)
    ) {
      errors.push(`files[${index}].sizeBytes exceeds the per-file limit`);
    }
    if (file.sha256 !== sha256Buffer(bytes)) {
      errors.push(`files[${index}].sha256 does not match decoded content`);
    }
  }
  if (
    totalBytes > Math.min(bundle.limits.maxBundleBytes, DEFAULT_SHARE_BUNDLE_LIMITS.maxBundleBytes)
  ) {
    errors.push('files total size exceeds the bundle limit');
  }
}

function validateBundleChat(bundle: DeepShareBundleV1, errors: string[]): void {
  const artifacts = new Map(bundle.manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const [chatIndex, chat] of bundle.chats.entries()) {
    uniqueIds(chat.messages, `chats[${chatIndex}].messages`, errors);
    for (const [messageIndex, message] of chat.messages.entries()) {
      for (const [referenceIndex, reference] of message.references.entries()) {
        const artifact = artifacts.get(reference.artifactId);
        const label = `chats[${chatIndex}].messages[${messageIndex}].references[${referenceIndex}]`;
        if (!artifact) {
          errors.push(`${label}.artifactId is not included`);
        } else if (artifact.type !== reference.artifactType) {
          errors.push(`${label}.artifactType does not match artifact`);
        }
      }
    }
  }
}

function uniqueIds<T extends { id: string }>(
  items: T[],
  label: string,
  errors: string[]
): Set<string> {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) errors.push(`${label}[${index}].id is duplicated`);
    ids.add(item.id);
  }
  return ids;
}

function decodeFileContent(content: DeepShareFileContent): Buffer {
  switch (content.encoding) {
    case 'utf8':
      return Buffer.from(content.text, 'utf8');
    case 'base64':
      return Buffer.from(content.data, 'base64');
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

function requireRecord(
  value: unknown,
  label: string,
  errors: string[]
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    record[key] = descriptor?.value;
  }
  return record;
}

function rejectExtraFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[]
): void {
  const extras = Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (extras.length > 0) errors.push(`${label} contains unsupported fields: ${extras.join(', ')}`);
}

function requireString(value: unknown, label: string, errors: string[]): string | null {
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`);
    return null;
  }
  return value;
}

function requireText(value: unknown, label: string, errors: string[]): string | null {
  const text = requireString(value, label, errors);
  if (text === null) return null;
  if (text.trim().length === 0) {
    errors.push(`${label} is required`);
    return null;
  }
  return text;
}

function requireId(value: unknown, label: string, errors: string[]): string | null {
  const id = requireText(value, label, errors);
  if (!id) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) {
    errors.push(`${label} is invalid`);
    return null;
  }
  return id;
}

function requireTimestamp(value: unknown, label: string, errors: string[]): string | null {
  const timestamp = requireString(value, label, errors);
  if (timestamp === null) return null;
  if (Number.isNaN(Date.parse(timestamp))) {
    errors.push(`${label} must be an ISO timestamp`);
    return null;
  }
  return timestamp;
}

function requireSha256(value: unknown, label: string, errors: string[]): string | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    errors.push(`${label} must be a lowercase sha256 hex digest`);
    return null;
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string, errors: string[]): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer`);
    return null;
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string, errors: string[]): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${label} must be a non-negative integer`);
    return null;
  }
  return value;
}

function requireBoolean(value: unknown, label: string, errors: string[]): boolean | null {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean`);
    return null;
  }
  return value;
}

function requireLiteral<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
  errors: string[]
): T[number] | null {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`${label} is unsupported`);
    return null;
  }
  return value;
}

function parseArray<T>(
  value: unknown,
  label: string,
  errors: string[],
  parseItem: (value: unknown, index: number, errors: string[]) => T | null
): T[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return null;
  }
  const parsed: T[] = [];
  for (const [index, item] of value.entries()) {
    const result = parseItem(item, index, errors);
    if (result) parsed.push(result);
  }
  return parsed.length === value.length ? parsed : null;
}

function isCanonicalBase64(value: string): boolean {
  if (value === '') return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function compareBy<T>(key: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => key(left).localeCompare(key(right), 'en-US');
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

function toStableJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Cannot canonicalize circular JSON value');
  seen.add(value);
  if (Array.isArray(value)) {
    const arrayValue = value.map((item) => toStableJsonValue(item, seen));
    seen.delete(value);
    return arrayValue;
  }
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const child: unknown = descriptor?.value;
    if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
    stable[key] = toStableJsonValue(child, seen);
  }
  seen.delete(value);
  return stable;
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
