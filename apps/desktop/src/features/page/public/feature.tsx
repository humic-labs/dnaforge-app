import { NotebookConflictDialog } from '../components/NotebookConflictDialog';
import { useEffect } from 'react';
import type {
  RendererFeature,
  RendererFeatureContext,
} from '../../../feature-registry/renderer-feature';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { installEntityReferenceHandler } from '../entity-ref/install-entity-reference-handler';

function PageReferencesActivation({ openView }: RendererFeatureContext) {
  const folders = useWorkspaceStore((state) => state.folders);
  useEffect(
    () => installEntityReferenceHandler({ folders, handleViewChange: openView }),
    [folders, openView]
  );
  return <NotebookConflictDialog />;
}

export const pageReferencesRendererFeature = {
  id: 'page-references',
  Activation: PageReferencesActivation,
} satisfies RendererFeature;
