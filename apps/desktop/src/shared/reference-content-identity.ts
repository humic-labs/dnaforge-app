export interface ReferenceContentIdentity {
  readonly sequenceIdentity: string;
  readonly annotationIdentity: string;
}

export interface ReferenceVersionIdentity extends ReferenceContentIdentity {
  readonly bundleFingerprint: string;
  readonly assetGenerations: readonly Readonly<{
    sourceFingerprint: string;
    inventoryFingerprint: string;
  }>[];
}
