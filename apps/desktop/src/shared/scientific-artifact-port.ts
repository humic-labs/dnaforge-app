import {
  parseWorkspaceIdentity,
  type ScientificAcceptedDocumentRevision,
  type ScientificWorkspaceCatalog,
} from '@waypoint/domain-services';
import { defineBlob } from '@waypoint/workspace-revisions';
import type { Primer } from './primer-artifacts/types';
import { pathRelativeToBoundary } from './path-boundary';

export type ScientificArtifactPublicationInput = {
  workspaceRoot: string;
  artifactPath: string;
  resourceId: string;
  representation: { format: 'primer-v2' | 'strain-entity-v1' | 'genbank-v1'; text: string };
  sequencePackageText?: string;
  mutationToken?: string;
} & ({ prior: ScientificAcceptedDocumentRevision } | { prior: null; expectedHead: string });

export interface ScientificArtifactPort {
  namespace(root: string): Promise<(ScientificWorkspaceCatalog & { head: string }) | null>;
  readText(
    path: string,
    root: string,
    readLegacy?: (path: string) => Promise<string>,
    acceptedHead?: string
  ): Promise<{ content: string; acceptedRevision: ScientificAcceptedDocumentRevision | null }>;
  publish(input: ScientificArtifactPublicationInput): Promise<ScientificAcceptedDocumentRevision>;
  primerById(id: string): Promise<Primer | null>;
  relationshipGitPaths(root: string, dirty: ReadonlyMap<string, unknown>): Promise<string[]>;
}

export class NativeArtifactPublicationPendingError extends Error {
  constructor(
    readonly accepted: ScientificAcceptedDocumentRevision,
    reason: string
  ) {
    super(`Save accepted; ${reason}`);
    this.name = 'NativeArtifactPublicationPendingError';
  }
}

export function prepareNativeArtifactSubmission(
  input: ScientificArtifactPublicationInput,
  workspace: string
) {
  const path = pathRelativeToBoundary(input.artifactPath, input.workspaceRoot);
  if (!path || (input.prior && input.prior.resourceId !== input.resourceId))
    throw new Error('The native artifact does not match its captured project identity.');
  const request = {
    workspace: parseWorkspaceIdentity(workspace),
    expectedHead: input.prior ? input.prior.workspaceVersionId : input.expectedHead,
    source: {
      kind: 'native-artifact' as const,
      expectedRevisionId: input.prior?.resourceRevisionId ?? null,
      entry: {
        resourceId: input.resourceId,
        path,
        representation: { ...input.representation },
        ...(input.sequencePackageText === undefined
          ? {}
          : { sequencePackageText: input.sequencePackageText }),
      },
    },
  };
  const operationId = `native-artifact:${defineBlob(new TextEncoder().encode(JSON.stringify(request))).hash.slice('sha256:'.length)}`;
  return {
    workspaceRoot: input.workspaceRoot,
    request: { ...request, operationId },
    ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
  };
}
