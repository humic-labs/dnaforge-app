import type { SequenceDesign } from './types';

export interface DesignDraftIdentity {
  constructId?: string | null;
  parentAcceptedAssemblyVersionId?: string | null;
}

export type ResolvedExistingDesignDraft =
  | { source: 'loaded'; design: SequenceDesign }
  | { source: 'artifact'; design: SequenceDesign };

export interface DesignDraftResolutionPort {
  loaded(designId: string): SequenceDesign | undefined;
  installFromArtifact(design: SequenceDesign): void;
}

export function resolveExistingDesignDraft(
  port: DesignDraftResolutionPort,
  input: {
    designId: string;
    artifactDesign: SequenceDesign | null;
    identity?: DesignDraftIdentity;
  }
): ResolvedExistingDesignDraft {
  const loaded = loadedDesignDraft(port, input.designId, input.identity);
  if (loaded) return { source: 'loaded', design: loaded };
  if (!input.artifactDesign) {
    throw new Error(
      `Draft ${input.designId} is not loaded and its artifact carries no design contents.`
    );
  }
  assertDesignDraftIdentity(input.artifactDesign, input.designId, input.identity, 'draft artifact');
  port.installFromArtifact(input.artifactDesign);
  const design = port.loaded(input.designId);
  if (!design) {
    throw new Error(`Draft ${input.designId} could not be loaded from its artifact.`);
  }
  return { source: 'artifact', design };
}

export function loadedDesignDraft(
  port: DesignDraftResolutionPort,
  designId: string,
  identity?: DesignDraftIdentity
): SequenceDesign | null {
  const loaded = port.loaded(designId);
  if (!loaded) return null;
  assertDesignDraftIdentity(loaded, designId, identity, 'loaded draft');
  return loaded;
}

export function assertDesignDraftIdentity(
  design: SequenceDesign,
  designId: string,
  identity: DesignDraftIdentity | undefined,
  label: string
): void {
  const mismatch =
    design.id !== designId ||
    (identity?.constructId != null && design.constructId !== identity.constructId) ||
    (identity?.parentAcceptedAssemblyVersionId != null &&
      design.parentAcceptedAssemblyVersionId !== identity.parentAcceptedAssemblyVersionId);
  if (mismatch) {
    throw new Error(`The ${label} for ${designId} belongs to a different construct or version.`);
  }
}
