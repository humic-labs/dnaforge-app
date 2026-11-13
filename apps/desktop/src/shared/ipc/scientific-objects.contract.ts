import type {
  ScientificAcceptedWorkspace,
  ScientificWorkspaceCatalog,
  ScientificWorkspaceProjectionResult,
  ScientificWorkspaceSubmitResult,
} from '@waypoint/domain-services';
import type { ScientificSnapshot } from '@waypoint/scientific-objects';
import type {
  DesktopScientificObjectReadRequest,
  DesktopScientificWorkspaceProjectionRequest,
  DesktopScientificWorkspaceRequest,
  DesktopScientificWorkspaceSubmitRequest,
} from '../scientific-objects-ipc';
import { defineGroup, invoke } from './contract';

export const scientificObjectsContract = defineGroup('scientificObjects', {
  catalog: invoke<[input: DesktopScientificWorkspaceRequest], ScientificWorkspaceCatalog>(),
  reconcileProjections: invoke<
    [input: DesktopScientificWorkspaceProjectionRequest],
    ScientificWorkspaceProjectionResult
  >(),
  list: invoke<[input: DesktopScientificWorkspaceRequest], ScientificAcceptedWorkspace>(),
  read: invoke<[input: DesktopScientificObjectReadRequest], ScientificSnapshot | null>(),
  submit: invoke<
    [input: DesktopScientificWorkspaceSubmitRequest],
    ScientificWorkspaceSubmitResult
  >(),
});
