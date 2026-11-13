export const MAX_PROTEIN_EXPERIMENT_FIXTURES = 4;
export interface ReviewRoundRequest {
  readonly runId: string;
  readonly mode: 'full-round' | 'experiment';
  readonly frozen: string;
  readonly slots: readonly string[];
}
export interface ProteinExperimentWorkerFixture {
  readonly structureViewId: string;
  readonly attrs: unknown;
}

export interface ProteinExperimentWorkerWorkspace {
  readonly folders: ReadonlyArray<{
    readonly path: string;
    readonly name: string;
    readonly addedAt: number;
    readonly pinned?: boolean;
  }>;
  readonly activeWorkspaceFile: string | null;
}

export interface ProteinExperimentPrepareRequest {
  readonly jobId: string;
  readonly label: string;
  readonly fixtures: ReadonlyArray<ProteinExperimentWorkerFixture>;
  readonly workspace: ProteinExperimentWorkerWorkspace;
  readonly renderProfile?: unknown;
  readonly purpose?: 'fresh-author' | 'saved-view-replay';
  readonly admission?: ReviewRoundRequest & { readonly slot: string };
}

export interface ProteinExperimentWorkerLease {
  readonly jobId: string;
  readonly workerId: string;
  readonly rendererProcessId?: number;
  readonly ownerRendererProcessId?: number;
}

export interface ProteinExperimentBindRequest {
  readonly jobId: string;
  readonly turnId: string;
}

export interface ProteinExperimentReleaseRequest {
  readonly jobId: string;
}

export type ProteinExperimentWorkerRequest =
  | {
      readonly requestId: string;
      readonly kind: 'assert-fresh-start';
      readonly jobId: string;
    }
  | {
      readonly requestId: string;
      readonly kind: 'prepare';
      readonly request: ProteinExperimentPrepareRequest;
    }
  | {
      readonly requestId: string;
      readonly kind: 'release';
      readonly jobId: string;
    };

export type ProteinExperimentWorkerResponse =
  | { readonly requestId: string; readonly ok: true }
  | { readonly requestId: string; readonly ok: false; readonly error: string };

export interface ProteinExperimentWorkersApi {
  checkAdmission(request: ReviewRoundRequest): Promise<void>;
  requestApproval(request: ReviewRoundRequest): Promise<void>;
  prepare(request: ProteinExperimentPrepareRequest): Promise<ProteinExperimentWorkerLease>;
  bind(request: ProteinExperimentBindRequest): Promise<void>;
  release(request: ProteinExperimentReleaseRequest): Promise<void>;
  ready(): Promise<void>;
  onRequest(callback: (request: ProteinExperimentWorkerRequest) => void): () => void;
  respond(response: ProteinExperimentWorkerResponse): void;
}
