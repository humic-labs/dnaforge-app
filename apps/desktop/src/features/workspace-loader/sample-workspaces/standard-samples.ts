import { STANDARD_SAMPLE_WORKSPACE_MANIFEST } from '../../../shared/sample-workspace-ipc';
import type { WorkspaceSource } from '../types';

export const STANDARD_SAMPLE_WORKSPACE_SOURCE: WorkspaceSource = {
  kind: 'sample-template',
  templateId: STANDARD_SAMPLE_WORKSPACE_MANIFEST.templateId,
  mode: 'reuse',
};
