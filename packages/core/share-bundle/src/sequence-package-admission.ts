import { parseGenBankRecords } from '@waypoint/sequence-utils';
import {
  defineBlob,
  parseMemberId,
  parseResourceId,
  parseResourcePath,
  parseWorkspacePath,
} from '@waypoint/workspace-revisions';
import { validatePortableWorkspaceTree as validateWorkspaceSyncManifestTree } from '@waypoint/workspace-revisions';
import { workspaceSyncSensitivePathExclusion } from './shared';

export const MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION = 9;
export const SEQUENCE_PACKAGE_ADMISSION_VERSION = 1;
export const SEQUENCE_PACKAGE_MARKER_SUFFIX = '/.forge/plasmid.json';

export const SEQUENCE_PACKAGE_ADMISSION_MAX_MARKER_BYTES = 4 * 1024 * 1024;
export const SEQUENCE_PACKAGE_ADMISSION_MAX_PRODUCT_BYTES = 32 * 1024 * 1024;

export interface SequencePackageAdmissionError {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface SequencePackageAdmissionDescriptor {
  readonly packageId: string;
  readonly root: string;
  readonly markerPath: string;
  readonly formatVersion: number;
  readonly productPath: string;
  readonly members: readonly {
    readonly memberId: string;
    readonly path: string;
    readonly role: string;
  }[];
  readonly requiredPaths: readonly string[];
  readonly topology?: 'linear' | 'circular';
  readonly sequenceChecksum?: string;
  readonly genBankChecksum?: string;
}

type Invalid = { readonly ok: false; readonly errors: readonly SequencePackageAdmissionError[] };
export type SequencePackageDescriptorResult =
  | { readonly ok: true; readonly descriptor: SequencePackageAdmissionDescriptor }
  | Invalid;

export function isSequencePackageAdmissionMarker(path: string): boolean {
  return path.toLowerCase().endsWith(SEQUENCE_PACKAGE_MARKER_SUFFIX);
}

export function isPortableSequencePackageHistory(
  marker: Record<string, unknown>,
  formatVersion: number,
  memberByPath: ReadonlyMap<string, Record<string, unknown>>
): boolean {
  if (formatVersion >= 7) {
    if (!record(marker.versionHistory)) return false;
    const history = marker.versionHistory;
    if (
      history.schema !== 'waypoint.sequence-history.v1' ||
      !Array.isArray(history.revisions) ||
      (history.headId !== null && typeof history.headId !== 'string')
    ) {
      return false;
    }
    let previousId: string | null = null;
    const revisionIds = new Set<string>();
    const operationIds = new Set<string>();
    for (const entry of history.revisions) {
      if (
        !record(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        revisionIds.has(entry.id) ||
        entry.parentId !== previousId ||
        typeof entry.operationId !== 'string' ||
        !entry.operationId ||
        operationIds.has(entry.operationId) ||
        !record(entry.productSnapshot)
      ) {
        return false;
      }
      const snapshot = entry.productSnapshot;
      const parsedSnapshotPath =
        typeof snapshot.path === 'string' ? parseResourcePath(snapshot.path) : undefined;
      const snapshotPath =
        parsedSnapshotPath?.ok && parsedSnapshotPath.value === snapshot.path
          ? parsedSnapshotPath.value
          : null;
      if (
        !snapshotPath?.startsWith('contents/') ||
        !/^sha256:[a-f0-9]{64}$/.test(String(snapshot.sha256 ?? '')) ||
        memberByPath.get(snapshotPath)?.role !== 'sequence-snapshot' ||
        memberByPath.get(snapshotPath)?.replaceable !== false
      ) {
        return false;
      }
      revisionIds.add(entry.id);
      operationIds.add(entry.operationId);
      previousId = entry.id;
    }
    if (history.headId !== previousId) return false;
  }
  return true;
}

export function parseSequencePackageAdmissionDescriptor(
  marker: unknown,
  markerPath: string
): SequencePackageDescriptorResult {
  const errors: SequencePackageAdmissionError[] = [];
  const fail = (code: string, message: string, path = markerPath) => {
    errors.push({ code, path, message });
  };
  const parsedPath = parseWorkspacePath(markerPath);
  if (
    !parsedPath.ok ||
    parsedPath.value !== markerPath ||
    !markerPath.endsWith(SEQUENCE_PACKAGE_MARKER_SUFFIX)
  ) {
    fail(
      'invalid-marker-path',
      'Sequence package marker must have its exact portable .forge/plasmid.json path.'
    );
    return { ok: false, errors };
  }
  const root = markerPath.slice(0, -SEQUENCE_PACKAGE_MARKER_SUFFIX.length);
  if (!root || !record(marker)) {
    fail('invalid-marker', 'Sequence package marker must be a JSON object in a package directory.');
    return { ok: false, errors };
  }
  if (
    typeof marker.schema !== 'string' ||
    !['waypoint.sequence.v1', 'waypoint.plasmid.v1'].includes(marker.schema) ||
    typeof marker.kind !== 'string' ||
    !['sequence', 'plasmid'].includes(marker.kind)
  )
    fail('invalid-marker', 'Unsupported sequence package schema or kind.');
  const packageId = typeof marker.id === 'string' ? marker.id.trim() : '';
  if (!parseResourceId(packageId).ok)
    fail('invalid-package-id', 'Sequence package requires a valid stable ID.');
  const formatVersion = marker.formatVersion === undefined ? 1 : marker.formatVersion;
  if (
    typeof formatVersion !== 'number' ||
    !Number.isSafeInteger(formatVersion) ||
    formatVersion < 1 ||
    formatVersion > MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION
  ) {
    fail(
      'unsupported-format',
      `Sequence package format must be between 1 and ${MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION}.`
    );
    return { ok: false, errors };
  }
  const product = record(marker.product) ? marker.product : {};
  const productFile = typeof product.file === 'string' ? product.file : '';
  const productRelative = parseResourcePath(productFile);
  if (
    !productRelative.ok ||
    productRelative.value !== productFile ||
    productFile.includes('/') ||
    !/\.(?:gb|gbk|gbff|genbank)$/iu.test(productFile)
  )
    fail(
      'invalid-product-path',
      'Product must be one portable GenBank filename at the package root.'
    );
  const productPath = `${root}/${productFile}`;
  if (
    product.topology !== undefined &&
    product.topology !== 'linear' &&
    product.topology !== 'circular'
  ) {
    fail('invalid-topology', 'Product topology must be linear or circular.');
  }
  for (const key of ['sequenceChecksum', 'genBankChecksum'] as const) {
    if (product[key] !== undefined && !isChecksum(product[key])) {
      fail('invalid-checksum', `Product ${key} must be a lowercase SHA-256 identity.`);
    }
  }

  const members: Array<{ memberId: string; path: string; role: string }> = [];
  const memberIds = new Set<string>();
  const memberByPath = new Map<string, Record<string, unknown>>();
  const requiredPaths = new Set([markerPath, productPath]);
  const rawMembers = marker.members === undefined && formatVersion === 1 ? [] : marker.members;
  if (!Array.isArray(rawMembers))
    fail('invalid-members', 'Sequence package members must be an array.');
  else
    for (const member of rawMembers) {
      if (!record(member)) {
        fail('invalid-member', 'Sequence package member must be an object.');
        continue;
      }
      const memberId = typeof member.id === 'string' ? member.id.trim() : '';
      const role = typeof member.role === 'string' ? member.role.trim() : '';
      if (!parseMemberId(memberId).ok)
        fail('invalid-member-id', 'Sequence package member requires a valid stable ID.');
      if (memberIds.has(memberId))
        fail('duplicate-member-id', `Sequence package duplicates member ID ${memberId}.`);
      memberIds.add(memberId);
      if (!role) fail('invalid-member-role', 'Sequence package member requires a role.');
      const relative = typeof member.path === 'string' ? member.path : '';
      const parsed = parseResourcePath(relative);
      if (
        !parsed.ok ||
        parsed.value !== relative ||
        !(relative.startsWith('contents/') || (formatVersion < 4 && relative.startsWith('files/')))
      ) {
        fail('invalid-member-path', 'Member must have an exact portable managed-payload path.');
        continue;
      }
      memberByPath.set(relative, member);
      const path = `${root}/${relative}`;
      if (requiredPaths.has(path))
        fail('duplicate-member-path', `Sequence package duplicates member path ${path}.`, path);
      requiredPaths.add(path);
      members.push({ memberId, path, role });
    }
  if (marker.assembly !== undefined) {
    if (!record(marker.assembly))
      fail('invalid-assembly', 'Sequence package assembly must be an object.');
    else if (marker.assembly.primers !== undefined) {
      if (!record(marker.assembly.primers))
        fail('invalid-assembly', 'Legacy primer catalog must be an object.');
      else
        for (const kind of ['csv', 'fasta'] as const) {
          const relative = marker.assembly.primers[kind];
          if (relative === undefined) continue;
          const parsed = typeof relative === 'string' ? parseResourcePath(relative) : undefined;
          const pattern = new RegExp(`^(?:contents|files|primers)/[^/]+\\.primers\\.${kind}$`, 'i');
          if (!parsed?.ok || parsed.value !== relative || !pattern.test(String(relative))) {
            fail('invalid-member-path', `Legacy ${kind} primer path is invalid.`);
          } else requiredPaths.add(`${root}/${relative}`);
        }
    }
  }
  if (formatVersion >= 5 && !validEntity(marker.entity, formatVersion)) {
    fail('invalid-metadata', 'Sequence package entity/schema metadata is malformed.');
  }
  if (!isPortableSequencePackageHistory(marker, formatVersion, memberByPath)) {
    fail('invalid-history', 'Sequence package history must retain its linked immutable snapshots.');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    descriptor: {
      packageId,
      root,
      markerPath,
      formatVersion,
      productPath,
      members,
      requiredPaths: [...requiredPaths],
      ...(product.topology !== undefined
        ? { topology: product.topology as 'linear' | 'circular' }
        : {}),
      ...(typeof product.sequenceChecksum === 'string'
        ? { sequenceChecksum: product.sequenceChecksum }
        : {}),
      ...(typeof product.genBankChecksum === 'string'
        ? { genBankChecksum: product.genBankChecksum }
        : {}),
    },
  };
}

export function validateSequencePackageAdmission(input: {
  readonly manifest: {
    readonly files: readonly {
      readonly path: string;
      readonly contentSha256: string;
      readonly sizeBytes: number;
    }[];
  };
  readonly packageBytes: ReadonlyMap<string, Uint8Array>;
}):
  | { readonly ok: true; readonly packages: readonly SequencePackageAdmissionDescriptor[] }
  | Invalid {
  const errors: SequencePackageAdmissionError[] = [];
  const tree = validateWorkspaceSyncManifestTree(input.manifest);
  if (!tree.ok)
    errors.push(...tree.errors.map((message) => ({ code: 'invalid-tree', path: '', message })));
  const files = new Map(input.manifest.files.map((file) => [file.path, file]));
  for (const file of input.manifest.files) {
    const exclusion = workspaceSyncSensitivePathExclusion(file.path);
    if (exclusion)
      errors.push({
        code: 'policy-excluded',
        path: file.path,
        message: `${file.path} is excluded by ${exclusion} policy.`,
      });
  }
  for (const [path, bytes] of input.packageBytes) {
    const file = files.get(path);
    if (
      !file ||
      file.sizeBytes !== bytes.byteLength ||
      `sha256:${file.contentSha256}` !== defineBlob(bytes).hash
    ) {
      errors.push({
        code: 'blob-mismatch',
        path,
        message: `Stored bytes do not match the immutable manifest at ${path}.`,
      });
    }
  }
  const packages: SequencePackageAdmissionDescriptor[] = [];
  const packageIds = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const file of input.manifest.files) {
    if (!isSequencePackageAdmissionMarker(file.path)) continue;
    const bytes = input.packageBytes.get(file.path);
    if (!bytes) {
      errors.push({
        code: 'missing-marker-bytes',
        path: file.path,
        message: `Missing stored marker bytes at ${file.path}.`,
      });
      continue;
    }
    let marker: unknown;
    try {
      marker = JSON.parse(decoder.decode(bytes));
    } catch {
      errors.push({
        code: 'invalid-marker',
        path: file.path,
        message: `Invalid UTF-8 JSON package marker at ${file.path}.`,
      });
      continue;
    }
    const parsed = parseSequencePackageAdmissionDescriptor(marker, file.path);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    const descriptor = parsed.descriptor;
    if (packageIds.has(descriptor.packageId)) {
      errors.push({
        code: 'duplicate-package-id',
        path: file.path,
        message: `Duplicate sequence package ID ${descriptor.packageId}.`,
      });
    }
    packageIds.add(descriptor.packageId);
    for (const path of descriptor.requiredPaths) {
      if (!files.has(path)) {
        const exclusion = workspaceSyncSensitivePathExclusion(path);
        errors.push({
          code: 'missing-member',
          path,
          message: `Sequence package ${descriptor.root} is incomplete: missing ${path}${exclusion ? ` (${exclusion} policy excludes this required member)` : ''}.`,
        });
      }
    }
    const transactionPath = `${descriptor.root}/.forge/sequence-metadata-transaction.json`;
    if (files.has(transactionPath)) {
      const transactionBytes = input.packageBytes.get(transactionPath);
      try {
        const transaction = transactionBytes
          ? JSON.parse(decoder.decode(transactionBytes))
          : undefined;
        if (
          !record(transaction) ||
          transaction.schema !== 'waypoint.sequence-metadata-transaction.v1' ||
          transaction.state !== 'complete' ||
          transaction.packageId !== descriptor.packageId
        ) {
          errors.push({
            code: 'pending-metadata-transaction',
            path: transactionPath,
            message: 'Package metadata transaction must be recovered locally before publication.',
          });
        }
      } catch {
        errors.push({
          code: 'pending-metadata-transaction',
          path: transactionPath,
          message: 'Package metadata transaction cannot be validated.',
        });
      }
    }
    const productBytes = input.packageBytes.get(descriptor.productPath);
    if (!productBytes) {
      errors.push({
        code: 'missing-product-bytes',
        path: descriptor.productPath,
        message: `Missing stored GenBank product bytes at ${descriptor.productPath}.`,
      });
    } else {
      try {
        const content = decoder.decode(productBytes);

        const locusLines = content.match(/^LOCUS\b.*$/gm) ?? [];
        const terminators = content.match(/^\/\/[ \t]*\r?$/gm) ?? [];
        if (
          locusLines.length !== 1 ||
          terminators.length !== 1 ||
          !/^LOCUS[ \t]+.+?[ \t]+\d+[ \t]+bp\b/i.test(locusLines[0]!)
        ) {
          throw new Error(
            'Product requires one complete GenBank record with a declared LOCUS length.'
          );
        }
        const records = parseGenBankRecords(content);
        if (records.length !== 1)
          throw new Error('Product must contain exactly one GenBank record.');
        const product = records[0]!;
        if (product.length !== product.sequence.length)
          throw new Error('GenBank LOCUS length differs from its sequence.');
        if (
          descriptor.topology !== undefined &&
          (descriptor.topology === 'circular') !== Boolean(product.circular)
        ) {
          throw new Error('Package topology differs from the authoritative GenBank LOCUS.');
        }
        if (
          descriptor.genBankChecksum !== undefined &&
          descriptor.genBankChecksum !== defineBlob(productBytes).hash
        ) {
          throw new Error('Package GenBank checksum differs from stored product bytes.');
        }

        const sequenceChecksums = [product.sequence, product.sequence.toUpperCase()].map(
          (sequence) => defineBlob(new TextEncoder().encode(sequence)).hash
        );
        if (
          descriptor.sequenceChecksum !== undefined &&
          !sequenceChecksums.some((hash) => hash === descriptor.sequenceChecksum)
        ) {
          throw new Error('Package sequence checksum differs from the stored GenBank sequence.');
        }
      } catch (error) {
        errors.push({
          code: 'invalid-product',
          path: descriptor.productPath,
          message: error instanceof Error ? error.message : 'Invalid GenBank product.',
        });
      }
    }
    packages.push(descriptor);
  }
  for (const [index, pkg] of packages.entries()) {
    if (packages.some((other, n) => n !== index && pkg.root.startsWith(`${other.root}/`))) {
      errors.push({
        code: 'nested-package',
        path: pkg.markerPath,
        message: 'Managed sequence package roots must not overlap.',
      });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, packages };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isChecksum(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function validEntity(value: unknown, formatVersion: number): boolean {
  if (!record(value) || !record(value.schema) || !record(value.fields)) return false;
  const schema = value.schema;
  if (
    !text(schema.schemaId) ||
    !text(schema.schemaRevisionId) ||
    !text(schema.name) ||
    !text(schema.displayName) ||
    schema.baseKind !== 'sequence' ||
    !Array.isArray(schema.fields) ||
    (formatVersion >= 6 && (!Number.isSafeInteger(schema.version) || Number(schema.version) < 1)) ||
    !text(value.registrationStatus) ||
    !['tracked', 'registered', 'drifted', 'unresolved'].includes(value.registrationStatus.trim()) ||
    (value.domainStatus !== null && typeof value.domainStatus !== 'string') ||
    (value.registryId !== null && typeof value.registryId !== 'string') ||
    !Array.isArray(value.relationships) ||
    (value.source !== undefined && !record(value.source))
  )
    return false;
  const keys = new Set<string>();
  for (const field of schema.fields) {
    if (
      !record(field) ||
      !text(field.key) ||
      !text(field.label) ||
      !text(field.type) ||
      keys.has(field.key.trim())
    )
      return false;
    keys.add(field.key.trim());
  }
  return value.relationships.every(
    (relationship) =>
      record(relationship) &&
      text(relationship.type) &&
      text(relationship.fromEntityId) &&
      text(relationship.toEntityId) &&
      record(relationship.payload)
  );
}
