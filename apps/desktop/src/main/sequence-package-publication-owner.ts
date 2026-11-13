import { AsyncLocalStorage } from 'node:async_hooks';

interface PackageBoundary {
  workspaceRoot: string;
  packageRoot: string;
}
export interface NativePackageFile extends PackageBoundary {
  path: string;
  content: Uint8Array;
}
export interface NativePackagePublication extends PackageBoundary {
  packageId: string;
  operationId: string;
  beforeMarkerContent: string;
  productContent: string;
  markerContent: string;
  files?: readonly { path: string; content: Uint8Array }[];
  beforePublish?(): void;
}
export interface NativePackageProduct extends PackageBoundary {
  operationId: string;
  content: string;
}
interface PublicationOwner {
  stageFile(input: NativePackageFile): Promise<boolean>;
  readBytes(path: string): Uint8Array | null;
  prepareProduct(input: NativePackageProduct): string;
  publish(input: NativePackagePublication): Promise<{ publicationPaths: readonly string[] } | null>;
}
const owners = new AsyncLocalStorage<PublicationOwner>();
export function hasSequencePackagePublicationOwner(): boolean {
  return owners.getStore() !== undefined;
}

export function withSequencePackagePublicationOwner<T>(
  owner: PublicationOwner,
  operation: () => Promise<T>
): Promise<T> {
  return owners.run(owner, operation);
}
export function stageAcceptedSequencePackageFile(input: NativePackageFile): Promise<boolean> {
  return owners.getStore()?.stageFile(input) ?? Promise.resolve(false);
}
export function readAcceptedSequencePackageBytes(path: string): Uint8Array | null {
  return owners.getStore()?.readBytes(path) ?? null;
}
export function prepareAcceptedSequencePackageProduct(input: NativePackageProduct): string {
  return owners.getStore()?.prepareProduct(input) ?? input.content;
}
export function publishAcceptedSequencePackage(
  input: NativePackagePublication
): Promise<{ publicationPaths: readonly string[] } | null> {
  return owners.getStore()?.publish(input) ?? Promise.resolve(null);
}
