import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type {
  PackageScratchLease,
  PackageScratchLeaseSet,
} from '../../shared/package-scratch-capability';
import {
  assertPhysicalPackageMember,
  assertPhysicalWriteDestination,
} from '../workspace-git/package-member-boundary';

const LEASE_TTL_MS = 60 * 60 * 1000;
const CREATE_ATTEMPTS = 8;

type LeaseRecord = PackageScratchLease & {
  ownerId: number;
  role: 'staging' | 'previous';
  device: number;
  inode: number;
  expiresAt: number;
  packageName: string;
  packageRoot: string;
  packageDevice?: number;
  packageInode?: number;
  authorizedExistingMembers: Set<string>;
  authorizedMemberIdentities: Map<string, FileIdentity>;
  installedMembers: Set<string>;
  installedMemberIdentities: Map<string, FileIdentity>;
  wholePackageInstalledIdentity?: FileIdentity;
  trustedMembers: Set<string>;
  mutationGroup: PackageScratchMutationGroup;
};

interface PackageScratchMutationGroup {
  tokens: Set<string>;
  records: Map<LeaseRecord['role'], LeaseRecord>;
  activeOperations: number;
  closing: boolean;
  idleWaiters: Set<() => void>;
  settlement?: Promise<void>;
  recovery?: PackageScratchRecoveryCallbacks;
  release(): void;
}

type FileIdentity = { device: number; inode: number };

type FileIdentityStat = {
  dev: number;
  ino: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type PackageScratchCapabilityDeps = {
  now(): number;
  randomHex(bytes: number): string;
  mkdir(path: string): Promise<void>;
  lstat(path: string): Promise<FileIdentityStat>;
  readFile(path: string): Promise<Buffer>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<Dirent[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  scheduleExpiration?(callback: () => void, delayMs: number): { cancel(): void };
};

const defaultDeps: PackageScratchCapabilityDeps = {
  now: () => Date.now(),
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  mkdir: (path) => mkdir(path),
  lstat: (path) => lstat(path),
  readFile: (path) => readFile(path),
  link: (existingPath, newPath) => link(existingPath, newPath),
  readlink: (path) => readlink(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  rm: (path, options) => rm(path, options),
  symlink: (target, path) => symlink(target, path),
  unlink: (path) => unlink(path),
  scheduleExpiration: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface PackageScratchIssueOptions {
  assertOwnerCurrent?: () => void;
  authorizedExistingMembers?: readonly string[];
  mutationRelease?: () => void;
  recovery?: PackageScratchRecoveryCallbacks;
}

export interface PackageScratchRecoveryCallbacks {
  markRequired(message: string): Promise<void>;
  clear(): Promise<void>;
}

export class PackageScratchCapabilityRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private expirationTimer: { cancel(): void } | undefined;

  constructor(private readonly deps: PackageScratchCapabilityDeps = defaultDeps) {}

  mutationPathForOwnedLease(cleanupToken: string, ownerId: number): string {
    if (typeof cleanupToken !== 'string' || !cleanupToken) {
      throw new Error('INVALID_PACKAGE_SCRATCH_CAPABILITY: cleanup token is required');
    }
    const lease = this.leases.get(cleanupToken);
    if (!lease) {
      throw new Error('INVALID_PACKAGE_SCRATCH_CAPABILITY: unknown or already-used cleanup token');
    }
    if (lease.ownerId !== ownerId) {
      throw new Error('UNAUTHORIZED_PACKAGE_SCRATCH_CAPABILITY: token belongs to another renderer');
    }
    if (lease.expiresAt <= this.deps.now()) {
      throw new Error('EXPIRED_PACKAGE_SCRATCH_CAPABILITY: cleanup token expired');
    }
    return lease.path;
  }

  async issue(
    packageRoot: string,
    ownerId: number,
    options: PackageScratchIssueOptions = {}
  ): Promise<PackageScratchLeaseSet> {
    options.assertOwnerCurrent?.();
    if (!isAbsolute(packageRoot)) {
      throw new Error(`PACKAGE_SCRATCH_PATH: package root must be absolute: "${packageRoot}"`);
    }
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
      throw new Error('PACKAGE_SCRATCH_OWNER: renderer owner id must be a positive integer');
    }

    this.settleExpired();
    const parent = dirname(packageRoot);
    const rootName = basename(packageRoot);
    if (!rootName || rootName === '.' || rootName === '..') {
      throw new Error(`PACKAGE_SCRATCH_PATH: package root has no usable name: "${packageRoot}"`);
    }
    const authorizedExistingMembers = normalizeAuthorizedMembers(options.authorizedExistingMembers);
    const packageIdentity =
      options.authorizedExistingMembers !== undefined
        ? await this.deps.lstat(packageRoot)
        : undefined;
    if (packageIdentity && !packageIdentity.isDirectory()) {
      throw new Error(
        `PACKAGE_SCRATCH_PACKAGE_IDENTITY: existing package root is not a directory: "${packageRoot}"`
      );
    }
    const authorizedMemberIdentities = packageIdentity
      ? await this.captureAuthorizedMemberIdentities(packageRoot, authorizedExistingMembers)
      : new Map<string, FileIdentity>();
    const mutationGroup = createMutationGroup(
      options.mutationRelease ?? (() => undefined),
      options.recovery
    );

    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const nameToken = `${this.deps.now()}-${this.deps.randomHex(8)}`;
      const stagingPath = join(parent, `.${rootName}.staging-${nameToken}`);
      const previousPath = join(parent, `.${rootName}.previous-${nameToken}`);
      const createdPaths: string[] = [];
      const issuedTokens: string[] = [];
      try {
        await this.deps.mkdir(stagingPath);
        createdPaths.push(stagingPath);
        await this.deps.mkdir(previousPath);
        createdPaths.push(previousPath);
        const staging = await this.recordLease(
          stagingPath,
          packageRoot,
          ownerId,
          rootName,
          'staging',
          mutationGroup,
          packageIdentity,
          authorizedExistingMembers,
          authorizedMemberIdentities
        );
        issuedTokens.push(staging.cleanupToken);
        const previous = await this.recordLease(
          previousPath,
          packageRoot,
          ownerId,
          rootName,
          'previous',
          mutationGroup,
          packageIdentity,
          authorizedExistingMembers,
          authorizedMemberIdentities
        );
        issuedTokens.push(previous.cleanupToken);
        options.assertOwnerCurrent?.();
        return { staging, previous };
      } catch (error) {
        for (const cleanupToken of issuedTokens) {
          this.consumeLease(cleanupToken);
        }
        const cleanupErrors: unknown[] = [];
        for (const path of [...createdPaths].reverse()) {
          try {
            await this.deps.rm(path, { recursive: true, force: true });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            `PACKAGE_SCRATCH_RESERVATION_CLEANUP: failed to clean an incomplete reservation for "${packageRoot}"`
          );
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }

    throw new Error(`PACKAGE_SCRATCH_COLLISION: could not reserve scratch for "${packageRoot}"`);
  }

  async remove(cleanupToken: string, ownerId: number): Promise<void> {
    if (typeof cleanupToken !== 'string' || !cleanupToken) {
      throw new Error('INVALID_PACKAGE_SCRATCH_CAPABILITY: cleanup token is required');
    }
    const lease = this.leases.get(cleanupToken);
    if (!lease) {
      throw new Error('INVALID_PACKAGE_SCRATCH_CAPABILITY: unknown or already-used cleanup token');
    }
    if (lease.ownerId !== ownerId) {
      throw new Error('UNAUTHORIZED_PACKAGE_SCRATCH_CAPABILITY: token belongs to another renderer');
    }
    if (lease.expiresAt <= this.deps.now()) {
      void this.settleGroup(lease.mutationGroup).catch((error: unknown) => {
        console.error('[package-scratch] expired transaction settlement failed:', error);
      });
      throw new Error('EXPIRED_PACKAGE_SCRATCH_CAPABILITY: cleanup token expired');
    }
    await this.runGroupOperation(lease.mutationGroup, async () => {
      this.consumeLease(cleanupToken);
      await this.cleanupLeaseDirectory(lease);
    });
    if (lease.mutationGroup.tokens.size === 0) {
      await lease.mutationGroup.recovery?.clear();
    }
  }

  assertGenericMutationAllowed(...paths: string[]): void {
    this.settleExpired();
    for (const path of paths) {
      for (const lease of this.leases.values()) {
        if (isWithinOrEqual(lease.path, path)) {
          throw new Error(
            `PACKAGE_SCRATCH_MUTATION_REQUIRES_CAPABILITY: "${path}" is inside active package scratch.`
          );
        }
      }
    }
  }

  async releaseOwner(ownerId: number): Promise<void> {
    const groups = new Set<PackageScratchMutationGroup>();
    for (const lease of this.leases.values()) {
      if (lease.ownerId === ownerId) groups.add(lease.mutationGroup);
    }
    await Promise.all([...groups].map((group) => this.settleGroup(group)));
  }

  async runTrackedMutation<T>(
    paths: readonly string[],
    ownerId: number,
    operation: () => Promise<T>
  ): Promise<T> {
    this.settleExpired();
    const groups = new Set<PackageScratchMutationGroup>();
    for (const path of paths) {
      for (const lease of this.leases.values()) {
        if (!isWithinOrEqual(lease.path, path)) continue;
        this.assertOwner(lease, ownerId);
        groups.add(lease.mutationGroup);
      }
    }
    if (groups.size === 0) return operation();
    if (groups.size !== 1) {
      throw new Error('PACKAGE_SCRATCH_MUTATION_GROUP: one operation crossed scratch transactions');
    }
    return this.runGroupOperation([...groups][0], operation);
  }

  validateGeneratedWrite(
    path: string,
    ownerId: number,
    options: { content?: string; append?: boolean } = {}
  ): void {
    const located = this.activeLeaseContaining(path);
    if (!located) return;
    const { lease, member } = located;
    this.assertOwner(lease, ownerId);
    if (lease.role !== 'staging') {
      throw new Error(
        'UNSAFE_PACKAGE_SCRATCH_WRITE: displaced-member recovery is write-protected.'
      );
    }
    if (!member || !isAllowedGeneratedFile(member)) {
      throw new Error(
        `UNSAFE_PACKAGE_SCRATCH_WRITE: "${member || path}" is not a generated package member.`
      );
    }
    const snapshotDigest = snapshotDigestFromGeneratedPath(member);
    if (
      snapshotDigest &&
      (options.append ||
        options.content === undefined ||
        createHash('sha256').update(options.content).digest('hex') !== snapshotDigest)
    ) {
      throw new Error(
        'UNSAFE_PACKAGE_SCRATCH_WRITE: sequence snapshot bytes do not match their immutable filename.'
      );
    }
    if (lease.trustedMembers.has(member)) {
      throw new Error(
        `UNSAFE_PACKAGE_SCRATCH_WRITE: generated member "${member}" was already written.`
      );
    }
  }

  recordGeneratedWrite(path: string, ownerId: number): void {
    const located = this.activeLeaseContaining(path);
    if (!located) return;
    this.assertOwner(located.lease, ownerId);
    if (located.member && isAllowedGeneratedFile(located.member)) {
      located.lease.trustedMembers.add(located.member);
    }
  }

  async renameAuthorizedMember(
    cleanupToken: string,
    ownerId: number,
    from: string,
    to: string
  ): Promise<void> {
    const lease = this.requireActiveLease(cleanupToken, ownerId);
    await this.runGroupOperation(lease.mutationGroup, () =>
      this.renameAuthorizedMemberForLease(lease, from, to)
    );
  }

  private async renameAuthorizedMemberForLease(
    lease: LeaseRecord,
    from: string,
    to: string
  ): Promise<void> {
    await this.assertCurrentIdentity(lease);

    const fromScratch = memberRelativeTo(lease.path, from);
    const toScratch = memberRelativeTo(lease.path, to);
    const fromPackage = memberRelativeTo(lease.packageRoot, from);
    const toPackage = memberRelativeTo(lease.packageRoot, to);

    const installsWholePackage =
      lease.role === 'staging' &&
      fromScratch === '' &&
      toPackage === '' &&
      from === lease.path &&
      to === lease.packageRoot;
    if (installsWholePackage) {
      try {
        await this.deps.lstat(lease.packageRoot);
        throw new Error(
          `PACKAGE_SCRATCH_INSTALL_EXISTS: package root already exists: "${lease.packageRoot}".`
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const unsafeMember = await this.findUnsafeMember(
        lease.path,
        lease.trustedMembers,
        lease.installedMemberIdentities
      );
      if (unsafeMember) {
        throw new Error(
          `UNSAFE_PACKAGE_SCRATCH_INSTALL: unexpected or untrusted member "${unsafeMember}".`
        );
      }
      await this.deps.rename(from, to);
      lease.wholePackageInstalledIdentity = identityOf(await this.deps.lstat(to));
      return;
    }

    const movesIntoScratch =
      fromPackage !== null &&
      toScratch !== null &&
      fromPackage === toScratch &&
      fromPackage.length > 0 &&
      isAllowedGeneratedFile(fromPackage);
    const movesOutOfScratch =
      fromScratch !== null &&
      toPackage !== null &&
      fromScratch === toPackage &&
      fromScratch.length > 0 &&
      isAllowedGeneratedFile(fromScratch);
    if (!movesIntoScratch && !movesOutOfScratch) {
      throw new Error(
        `UNAUTHORIZED_PACKAGE_SCRATCH_RENAME: move must mirror one generated member between ` +
          `"${lease.packageRoot}" and "${lease.path}".`
      );
    }

    await this.assertCurrentPackageIdentity(lease);
    const member = movesIntoScratch ? toScratch : fromScratch;
    if (member === null) {
      throw new Error('PACKAGE_SCRATCH_RENAME_INVARIANT: authorized member was not relative.');
    }
    if (movesIntoScratch && isRootProductMember(member)) {
      await assertPhysicalWriteDestination(lease.packageRoot, from);
    } else if (movesIntoScratch) {
      await assertPhysicalPackageMember(lease.packageRoot, from);
    } else {
      await assertPhysicalWriteDestination(lease.packageRoot, to);
    }

    if (
      movesIntoScratch &&
      lease.role === 'previous' &&
      !lease.authorizedExistingMembers.has(member)
    ) {
      throw new Error(
        `UNAUTHORIZED_PACKAGE_SCRATCH_RENAME: member "${member}" is not recorded by the verified package marker.`
      );
    }
    if (movesIntoScratch && lease.role === 'staging' && !lease.installedMembers.has(member)) {
      throw new Error(
        `UNAUTHORIZED_PACKAGE_SCRATCH_ROLLBACK: member "${member}" was not installed by this transaction.`
      );
    }
    if (movesOutOfScratch && !lease.trustedMembers.has(member)) {
      throw new Error(
        `UNTRUSTED_PACKAGE_SCRATCH_RENAME: member "${member}" was not created or displaced by this transaction.`
      );
    }

    const expectedIdentity =
      lease.role === 'previous'
        ? lease.authorizedMemberIdentities.get(member)
        : lease.installedMemberIdentities.get(member);
    if (movesIntoScratch) {
      if (!expectedIdentity) {
        throw new Error(
          `UNAUTHORIZED_PACKAGE_SCRATCH_RENAME: member "${member}" did not exist when authority was issued.`
        );
      }
      await this.deps.rename(from, to);
      const movedIdentity = identityOf(await this.deps.lstat(to));
      if (!sameIdentity(movedIdentity, expectedIdentity)) {
        try {
          await this.moveFileNoClobber(to, from);
        } catch (restoreError) {
          throw new AggregateError(
            [restoreError],
            `REPLACED_PACKAGE_MEMBER: "${member}" changed after verification and remains in recovery at "${to}".`
          );
        }
        throw new Error(
          `REPLACED_PACKAGE_MEMBER: "${member}" changed after destructive authority was issued.`
        );
      }
    } else {
      const sourceIdentity = identityOf(await this.deps.lstat(from));
      await this.moveFileNoClobber(from, to);
      if (lease.role === 'staging') {
        lease.installedMemberIdentities.set(member, sourceIdentity);
      }
    }
    if (movesIntoScratch && lease.role === 'previous') {
      lease.trustedMembers.add(member);
    } else if (movesIntoScratch) {
      lease.installedMembers.delete(member);
      lease.installedMemberIdentities.delete(member);
    } else if (lease.role === 'staging') {
      lease.installedMembers.add(member);
    }
  }

  private async recordLease(
    path: string,
    packageRoot: string,
    ownerId: number,
    packageName: string,
    role: LeaseRecord['role'],
    mutationGroup: PackageScratchMutationGroup,
    packageIdentity: { dev: number; ino: number } | undefined,
    authorizedExistingMembers: ReadonlySet<string> = new Set(),
    authorizedMemberIdentities: ReadonlyMap<string, FileIdentity> = new Map()
  ): Promise<PackageScratchLease> {
    const identity = await this.deps.lstat(path);
    if (!identity.isDirectory()) {
      throw new Error(
        `PACKAGE_SCRATCH_IDENTITY: main-created scratch is not a directory: "${path}"`
      );
    }
    let cleanupToken = '';
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const candidate = this.deps.randomHex(32);
      if (!this.leases.has(candidate)) {
        cleanupToken = candidate;
        break;
      }
    }
    if (!cleanupToken) {
      throw new Error('PACKAGE_SCRATCH_TOKEN_COLLISION: could not mint a unique cleanup token');
    }
    const record: LeaseRecord = {
      path,
      cleanupToken,
      ownerId,
      role,
      device: identity.dev,
      inode: identity.ino,
      expiresAt: this.deps.now() + LEASE_TTL_MS,
      packageName,
      packageRoot,
      packageDevice: packageIdentity?.dev,
      packageInode: packageIdentity?.ino,
      authorizedExistingMembers: new Set(authorizedExistingMembers),
      authorizedMemberIdentities: new Map(authorizedMemberIdentities),
      installedMembers: new Set(),
      installedMemberIdentities: new Map(),
      trustedMembers: new Set(),
      mutationGroup,
    };
    this.leases.set(cleanupToken, record);
    mutationGroup.tokens.add(cleanupToken);
    mutationGroup.records.set(role, record);
    this.rescheduleExpiration();
    return { path, cleanupToken };
  }

  private async findUnsafeMember(
    root: string,
    trustedMembers: ReadonlySet<string>,
    trustedMemberIdentities: ReadonlyMap<string, FileIdentity>,
    relativeDir = ''
  ): Promise<string | null> {
    const entries = await this.deps.readdir(relativeDir ? join(root, relativeDir) : root);
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const expectedIdentity = trustedMemberIdentities.get(relativePath);
        const currentIdentity = identityOf(await this.deps.lstat(join(root, relativePath)));
        if (
          !isRootProductMember(relativePath) ||
          !trustedMembers.has(relativePath) ||
          !expectedIdentity ||
          !sameIdentity(currentIdentity, expectedIdentity)
        ) {
          return relativePath;
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (
          relativePath !== '.forge' &&
          relativePath !== 'primers' &&
          relativePath !== 'contents'
        ) {
          return relativePath;
        }
        const nestedUnsafe = await this.findUnsafeMember(
          root,
          trustedMembers,
          trustedMemberIdentities,
          relativePath
        );
        if (nestedUnsafe) return nestedUnsafe;
        continue;
      }
      if (
        !entry.isFile() ||
        !isAllowedGeneratedFile(relativePath) ||
        !trustedMembers.has(relativePath)
      ) {
        return relativePath;
      }
      const snapshotDigest = snapshotDigestFromGeneratedPath(relativePath);
      if (
        snapshotDigest &&
        createHash('sha256')
          .update(await this.deps.readFile(join(root, relativePath)))
          .digest('hex') !== snapshotDigest
      ) {
        return relativePath;
      }
    }
    return null;
  }

  private activeLeaseContaining(
    path: string
  ): { lease: LeaseRecord; member: string | null } | null {
    this.settleExpired();
    for (const lease of this.leases.values()) {
      const member = memberRelativeTo(lease.path, path);
      if (member !== null) return { lease, member };
    }
    return null;
  }

  private requireActiveLease(cleanupToken: string, ownerId: number): LeaseRecord {
    const lease = this.leases.get(cleanupToken);
    if (!lease) {
      throw new Error('INVALID_PACKAGE_SCRATCH_CAPABILITY: unknown or already-used cleanup token');
    }
    this.assertOwner(lease, ownerId);
    if (lease.expiresAt <= this.deps.now()) {
      void this.settleGroup(lease.mutationGroup).catch((error: unknown) => {
        console.error('[package-scratch] expired transaction settlement failed:', error);
      });
      throw new Error('EXPIRED_PACKAGE_SCRATCH_CAPABILITY: cleanup token expired');
    }
    return lease;
  }

  private assertOwner(lease: LeaseRecord, ownerId: number): void {
    if (lease.ownerId !== ownerId) {
      throw new Error('UNAUTHORIZED_PACKAGE_SCRATCH_CAPABILITY: token belongs to another renderer');
    }
  }

  private async assertCurrentIdentity(lease: LeaseRecord): Promise<void> {
    const current = await this.deps.lstat(lease.path);
    if (!current.isDirectory() || current.dev !== lease.device || current.ino !== lease.inode) {
      throw new Error(
        'REPLACED_PACKAGE_SCRATCH_CAPABILITY: scratch path no longer names the directory main created'
      );
    }
  }

  private async assertCurrentPackageIdentity(lease: LeaseRecord): Promise<void> {
    if (lease.packageDevice === undefined || lease.packageInode === undefined) {
      throw new Error(
        'UNVERIFIED_PACKAGE_SCRATCH_RENAME: existing package identity was not authorized.'
      );
    }
    const current = await this.deps.lstat(lease.packageRoot);
    if (
      !current.isDirectory() ||
      current.dev !== lease.packageDevice ||
      current.ino !== lease.packageInode
    ) {
      throw new Error(
        'REPLACED_PACKAGE_ROOT: package root no longer names the directory main verified.'
      );
    }
  }

  private async captureAuthorizedMemberIdentities(
    packageRoot: string,
    members: ReadonlySet<string>
  ): Promise<Map<string, FileIdentity>> {
    const identities = new Map<string, FileIdentity>();
    for (const member of members) {
      try {
        const stat = await this.deps.lstat(join(packageRoot, member));
        if (!stat.isFile() && !(isRootProductMember(member) && stat.isSymbolicLink())) {
          throw new Error(
            `INVALID_PACKAGE_SCRATCH_AUTHORITY: "${member}" is not a physical generated file.`
          );
        }
        identities.set(member, identityOf(stat));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return identities;
  }

  private async moveFileNoClobber(from: string, to: string): Promise<void> {
    const stat = await this.deps.lstat(from);
    if (stat.isFile()) {
      await this.deps.link(from, to);
    } else if (stat.isSymbolicLink()) {
      await this.deps.symlink(await this.deps.readlink(from), to);
    } else {
      throw new Error(`PACKAGE_SCRATCH_MEMBER_TYPE: "${from}" is not a file or symbolic link.`);
    }
    await this.deps.unlink(from);
  }

  private async cleanupLeaseDirectory(lease: LeaseRecord): Promise<void> {
    let current: FileIdentityStat;
    try {
      current = await this.deps.lstat(lease.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!current.isDirectory() || current.dev !== lease.device || current.ino !== lease.inode) {
      throw new Error(
        'REPLACED_PACKAGE_SCRATCH_CAPABILITY: scratch path no longer names the directory main created'
      );
    }

    const recoveryPath = join(
      dirname(lease.path),
      `.${lease.packageName}.recovery-${this.deps.now()}-${this.deps.randomHex(8)}`
    );
    await this.deps.rename(lease.path, recoveryPath);

    const unsafeMember = await this.findUnsafeMember(
      recoveryPath,
      lease.trustedMembers,
      lease.role === 'previous' ? lease.authorizedMemberIdentities : lease.installedMemberIdentities
    );
    if (unsafeMember) {
      throw new Error(
        `UNSAFE_PACKAGE_SCRATCH_CONTENT: unexpected member "${unsafeMember}" was not deleted. ` +
          `Recovery data remains at "${recoveryPath}".`
      );
    }
    await this.deps.rm(recoveryPath, { recursive: true, force: true });
  }

  private async settleGroup(group: PackageScratchMutationGroup): Promise<void> {
    if (group.settlement) return group.settlement;
    group.closing = true;
    const settlement = (async () => {
      let coherent = false;
      let recoveryRecorded = false;
      try {
        await this.waitForGroupIdle(group);
        if (group.tokens.size > 0) {
          const staging = group.records.get('staging');
          const previous = group.records.get('previous');
          if (!staging || !previous) {
            throw new Error('PACKAGE_SCRATCH_SETTLEMENT_INVARIANT: lease pair is incomplete');
          }
          if (group.tokens.has(staging.cleanupToken)) {
            await group.recovery?.markRequired(
              `Package replacement for "${staging.packageRoot}" was interrupted before commit.`
            );
            recoveryRecorded = Boolean(group.recovery);
            await this.rollbackUncommittedGroup(staging, previous);
          }
          coherent = true;

          const cleanupErrors: unknown[] = [];
          for (const lease of [staging, previous]) {
            try {
              await this.cleanupLeaseDirectory(lease);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          for (const token of [...group.tokens]) this.consumeLease(token, false);
          if (cleanupErrors.length > 0) {
            console.warn(
              '[package-scratch] settled live package but retained recovery scratch:',
              new AggregateError(cleanupErrors, 'package scratch cleanup failed after settlement')
            );
          }
          if (recoveryRecorded) await group.recovery?.clear();
        } else {
          coherent = true;
        }
      } finally {
        if (!coherent && recoveryRecorded) {
          for (const token of [...group.tokens]) this.consumeLease(token, false);
        }
        group.release();
        this.rescheduleExpiration();
      }
    })();
    group.settlement = settlement;
    return settlement;
  }

  private async rollbackUncommittedGroup(
    staging: LeaseRecord,
    previous: LeaseRecord
  ): Promise<void> {
    if (staging.packageDevice === undefined || staging.packageInode === undefined) {
      await this.rollbackUncommittedNewPackage(staging);
      return;
    }

    await this.assertCurrentPackageIdentity(staging);
    await this.assertCurrentIdentity(staging);
    if (previous.trustedMembers.size > 0) await this.assertCurrentIdentity(previous);

    for (const member of [...staging.installedMembers].reverse()) {
      const expected = staging.installedMemberIdentities.get(member);
      if (!expected) {
        throw new Error(
          `PACKAGE_SCRATCH_SETTLEMENT_INVARIANT: installed member "${member}" has no identity`
        );
      }
      await this.restoreExactMember(
        join(staging.packageRoot, member),
        join(staging.path, member),
        expected,
        `installed member "${member}"`
      );
    }

    for (const member of [...previous.trustedMembers].reverse()) {
      const expected = previous.authorizedMemberIdentities.get(member);
      if (!expected) {
        throw new Error(
          `PACKAGE_SCRATCH_SETTLEMENT_INVARIANT: displaced member "${member}" has no identity`
        );
      }
      await this.restoreExactMember(
        join(previous.path, member),
        join(previous.packageRoot, member),
        expected,
        `displaced member "${member}"`
      );
    }
  }

  private async rollbackUncommittedNewPackage(staging: LeaseRecord): Promise<void> {
    const scratchIdentity = await this.identityIfPresent(staging.path);
    if (scratchIdentity) {
      if (!sameIdentity(scratchIdentity, { device: staging.device, inode: staging.inode })) {
        throw new Error(
          'REPLACED_PACKAGE_SCRATCH_CAPABILITY: new-package staging identity changed before settlement'
        );
      }
      const packageIdentity = await this.identityIfPresent(staging.packageRoot);
      if (packageIdentity) {
        throw new Error(
          'PACKAGE_SCRATCH_SETTLEMENT_CONFLICT: package appeared before staged install committed'
        );
      }
      return;
    }

    const expected = staging.wholePackageInstalledIdentity;
    if (!expected) {
      throw new Error(
        'PACKAGE_SCRATCH_SETTLEMENT_INVARIANT: uncommitted staging root disappeared without an installed identity'
      );
    }
    const installedIdentity = await this.identityIfPresent(staging.packageRoot);
    if (!installedIdentity || !sameIdentity(installedIdentity, expected)) {
      throw new Error(
        'REPLACED_PACKAGE_ROOT: uncommitted new package changed before owner-loss settlement'
      );
    }
    await this.deps.rename(staging.packageRoot, staging.path);
  }

  private async restoreExactMember(
    source: string,
    destination: string,
    expected: FileIdentity,
    label: string
  ): Promise<void> {
    const sourceIdentity = await this.identityIfPresent(source);
    if (sourceIdentity) {
      if (!sameIdentity(sourceIdentity, expected)) {
        throw new Error(`REPLACED_PACKAGE_MEMBER: ${label} changed before settlement`);
      }
      await this.moveFileNoClobber(source, destination);
      return;
    }
    const destinationIdentity = await this.identityIfPresent(destination);
    if (!destinationIdentity || !sameIdentity(destinationIdentity, expected)) {
      throw new Error(`MISSING_PACKAGE_MEMBER: ${label} could not be restored exactly`);
    }
  }

  private async identityIfPresent(path: string): Promise<FileIdentity | undefined> {
    try {
      return identityOf(await this.deps.lstat(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async runGroupOperation<T>(
    group: PackageScratchMutationGroup,
    operation: () => Promise<T>
  ): Promise<T> {
    if (group.closing) {
      throw new Error('PACKAGE_SCRATCH_SETTLING: transaction owner is no longer available');
    }
    group.activeOperations += 1;
    try {
      return await operation();
    } finally {
      group.activeOperations -= 1;
      if (group.activeOperations === 0) {
        for (const resolve of group.idleWaiters) resolve();
        group.idleWaiters.clear();
      }
      this.maybeReleaseGroup(group);
    }
  }

  private async waitForGroupIdle(group: PackageScratchMutationGroup): Promise<void> {
    if (group.activeOperations === 0) return;
    await new Promise<void>((resolve) => group.idleWaiters.add(resolve));
  }

  private settleExpired(): void {
    const now = this.deps.now();
    const expiredGroups = new Set<PackageScratchMutationGroup>();
    for (const lease of this.leases.values()) {
      if (lease.expiresAt <= now) expiredGroups.add(lease.mutationGroup);
    }
    for (const group of expiredGroups) {
      void this.settleGroup(group).catch((error: unknown) => {
        console.error('[package-scratch] expired transaction settlement failed:', error);
      });
    }
    this.rescheduleExpiration();
  }

  private consumeLease(cleanupToken: string, reschedule = true): void {
    const lease = this.leases.get(cleanupToken);
    if (!lease) return;
    this.leases.delete(cleanupToken);
    const group = lease.mutationGroup;
    if (group) {
      group.tokens.delete(cleanupToken);
      this.maybeReleaseGroup(group);
    }
    if (reschedule) this.rescheduleExpiration();
  }

  private rescheduleExpiration(): void {
    this.expirationTimer?.cancel();
    this.expirationTimer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const lease of this.leases.values()) {
      if (!lease.mutationGroup.closing) earliest = Math.min(earliest, lease.expiresAt);
    }
    if (!Number.isFinite(earliest)) return;
    const scheduleExpiration = this.deps.scheduleExpiration ?? defaultDeps.scheduleExpiration;
    if (!scheduleExpiration) return;
    this.expirationTimer = scheduleExpiration(
      () => {
        this.expirationTimer = undefined;
        this.settleExpired();
      },
      Math.max(0, earliest - this.deps.now())
    );
  }

  private maybeReleaseGroup(group: PackageScratchMutationGroup): void {
    if (!group.closing && group.tokens.size === 0 && group.activeOperations === 0) {
      group.release();
    }
  }
}

function createMutationGroup(
  releaseMutation: () => void,
  recovery?: PackageScratchRecoveryCallbacks
): PackageScratchMutationGroup {
  let released = false;
  return {
    tokens: new Set(),
    records: new Map(),
    activeOperations: 0,
    closing: false,
    idleWaiters: new Set(),
    recovery,
    release: () => {
      if (released) return;
      released = true;
      releaseMutation();
    },
  };
}

function normalizeAuthorizedMembers(members: readonly string[] | undefined): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const member of members ?? []) {
    const relativePath = member.replace(/\\/g, '/');
    if (!relativePath || !isAllowedGeneratedFile(relativePath)) {
      throw new Error(
        `INVALID_PACKAGE_SCRATCH_AUTHORITY: "${member}" is not an exact generated package member.`
      );
    }
    normalized.add(relativePath);
  }
  return normalized;
}

function isAllowedGeneratedFile(relativePath: string): boolean {
  if (relativePath === '.forge/plasmid.json') return true;
  if (/^(?:contents|primers)\/[^/]+\.primers\.(?:csv|fasta)$/i.test(relativePath)) return true;
  if (snapshotDigestFromGeneratedPath(relativePath)) return true;
  return !relativePath.includes('/') && /\.(?:gb|gbk|gbff|genbank)$/i.test(relativePath);
}

function snapshotDigestFromGeneratedPath(relativePath: string): string | null {
  return /^contents\/sequence-snapshot-([a-f0-9]{64})\.gb$/.exec(relativePath)?.[1] ?? null;
}

function isRootProductMember(relativePath: string): boolean {
  return !relativePath.includes('/') && /\.(?:gb|gbk|gbff|genbank)$/i.test(relativePath);
}

function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function memberRelativeTo(root: string, path: string): string | null {
  const member = relative(root, path);
  if (member === '') return '';
  if (
    isAbsolute(member) ||
    member === '..' ||
    member.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    return null;
  }
  return member.replace(/\\/g, '/');
}

function isWithinOrEqual(root: string, path: string): boolean {
  return memberRelativeTo(root, path) !== null;
}

export const packageScratchCapabilities = new PackageScratchCapabilityRegistry();
