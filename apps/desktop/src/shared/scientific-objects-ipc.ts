import type {
  ScientificObjectReadRequest,
  ScientificWorkspaceRequest,
  ScientificWorkspaceSubmitRequest,
} from '@waypoint/domain-services';

export interface DesktopScientificWorkspaceRequest {
  readonly workspaceRoot: string;
  readonly request: ScientificWorkspaceRequest;
}
export interface DesktopScientificObjectReadRequest {
  readonly workspaceRoot: string;
  readonly request: ScientificObjectReadRequest;
}
export interface DesktopScientificWorkspaceSubmitRequest {
  readonly workspaceRoot: string;
  readonly request: ScientificWorkspaceSubmitRequest;
  readonly mutationToken?: string;
}

export interface DesktopScientificWorkspaceProjectionRequest extends DesktopScientificWorkspaceRequest {
  readonly mutationToken?: string;
}
