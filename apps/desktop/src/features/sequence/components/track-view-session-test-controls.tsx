import { render } from '@testing-library/react';
import { WorkspaceCommandProvider } from '../../../test/document-save-commands';
import { trackViewFixture } from '../../../shared/track-view-fixture';
import type { Tab } from '../../canvas/types';
import { TrackViewActions } from './TrackViewActions';
import { useTrackViewSessionSource } from './useTrackViewSessionSource';

function SessionControls({
  tab,
  capture,
  readyForDirtyCheck,
}: {
  tab: Tab;
  capture: () => ReturnType<typeof trackViewFixture>;
  readyForDirtyCheck: boolean;
}) {
  const session = useTrackViewSessionSource(tab, {
    referenceName: 'Session reference',
    readyForDirtyCheck,
    capture,
  });
  if (!session) throw new Error('The fixture tab has no track-view session.');
  return <TrackViewActions tab={tab} session={session} isActive />;
}

export function controls(tab: Tab, capture = () => trackViewFixture(), readyForDirtyCheck = true) {
  return render(
    <WorkspaceCommandProvider>
      <SessionControls tab={tab} capture={capture} readyForDirtyCheck={readyForDirtyCheck} />
    </WorkspaceCommandProvider>
  );
}
