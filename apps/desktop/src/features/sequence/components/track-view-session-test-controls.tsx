import { render } from '@testing-library/react';
import { WorkspaceCommandProvider } from '../../../test/document-save-commands';
import { trackViewFixture } from '../../../shared/track-view-fixture';
import type { Tab } from '../../canvas/types';
import { TrackViewActions } from './TrackViewActions';
export function controls(tab: Tab, capture = () => trackViewFixture(), readyForDirtyCheck = true) {
  return render(<WorkspaceCommandProvider><TrackViewActions tab={tab} capture={capture} referenceName="Session reference" isActive readyForDirtyCheck={readyForDirtyCheck} /></WorkspaceCommandProvider>);
}
