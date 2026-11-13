import type { AcceptedAssemblyVersion } from './accepted-types';

export type FinalizedPlasmidIdentity = {
  productPath: string;
  packageRoot: string;
  metaPath: string;
  constructId: string;
  acceptedVersion: AcceptedAssemblyVersion;
};

const identities = new Map<string, FinalizedPlasmidIdentity>();

export function rememberFinalizedPlasmid(identity: FinalizedPlasmidIdentity): void {
  identities.set(identity.constructId, identity);
}

export function plasmidIdentityForDocument(documentId: string): FinalizedPlasmidIdentity | null {
  return identities.get(documentId) ?? null;
}

export function forgetFinalizedPlasmid(documentId: string): void {
  identities.delete(documentId);
}

export function clearFinalizedPlasmidIdentitiesForTests(): void {
  identities.clear();
}
