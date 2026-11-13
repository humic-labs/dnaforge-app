import { useLayoutEffect } from 'react';
import { ReleaseNotesModal } from '../../../components/ReleaseNotesModal';
import type { RendererFeature } from '../../../feature-registry/renderer-feature';
import { usePostUpdateToast } from '../../../hooks/usePostUpdateToast';
import { useReleaseNotesPresentation } from '../../../hooks/useReleaseNotesPresentation';

type OpenReleaseNotes = ReturnType<typeof useReleaseNotesPresentation>['open'];
const listeners = new Set<OpenReleaseNotes>();

export const openReleaseNotes: OpenReleaseNotes = (...args) => {
  for (const open of listeners) open(...args);
};

function ReleaseNotesActivation() {
  const releaseNotes = useReleaseNotesPresentation();
  useLayoutEffect(() => {
    listeners.add(releaseNotes.open);
    return () => {
      listeners.delete(releaseNotes.open);
    };
  }, [releaseNotes.open]);
  usePostUpdateToast((version, sourceElement) =>
    releaseNotes.open('post_update_toast', version, sourceElement)
  );
  return <ReleaseNotesModal {...releaseNotes.modalProps} />;
}

export const releaseNotesRendererFeature: RendererFeature = {
  id: 'release-notes',
  Activation: ReleaseNotesActivation,
};
