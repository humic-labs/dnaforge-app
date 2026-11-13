export type PackageScratchLease = Readonly<{
  path: string;
  cleanupToken: string;
}>;

export type PackageScratchLeaseSet = Readonly<{
  staging: PackageScratchLease;
  previous: PackageScratchLease;
}>;
