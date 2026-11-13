import { beforeEach, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
const { activeHost } = vi.hoisted(() => ({ activeHost: vi.fn() }));
import {
  isRegisteredStructureAgentVisible,
  type RegisteredStructureVisibilityCandidate,
} from './visibility';

vi.mock('../../page/public/embeds/structure3d/molstar/cache', () => ({
  hasActiveMolstarViewerHost: activeHost,
}));
const candidate = (id: string): RegisteredStructureVisibilityCandidate => ({
  registrationId: id,
  structureId: id,
  structureViewId: id,
  bindingId: null,
  interactionKey: id,
  viewerId: 'data:same-coordinates',
  entry: {
    label: id,
    data: {
      source: 'file',
      sourceId: 'test coordinates',
      structureLinkOwnerId: 'protein\u0000inspection-tab',
    },
  },
});
beforeEach(() => {
  activeHost.mockReset().mockReturnValue(true);
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        activeTabId: 'inspection-tab',
        tabs: [
          {
            id: 'inspection-tab',
            type: 'structure',
            entityId: 'inspection:dna',
            label: 'Protein',
            structureInspection: {
              request: { entityId: 'dna', translation: 'MAG' },
              viewSettings: { candidateId: 'saved:current', structureViewId: 'current' },
            },
          },
        ],
      },
    },
  });
});
it('does not let an old source registration claim the new document’s connected renderer after Save', () => {
  const documentId = 'molecular-document:scope::new-document';
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        activeTabId: 'document-tab',
        tabs: [
          { id: 'document-tab', type: 'structure', entityId: documentId, label: 'Saved document' },
        ],
      },
    },
  });
  activeHost.mockImplementation(
    (_key: string, registrationId?: string) =>
      registrationId === undefined || registrationId === documentId
  );
  const stale = candidate('old-source-view');
  stale.entry = {
    label: 'Old source',
    data: { molecularDocumentId: '87f031ff-796e-4a32-8719-b176a30b90c7' },
  };
  expect(isRegisteredStructureAgentVisible(stale)).toBe(false);
  expect(activeHost).toHaveBeenCalledWith('data:same-coordinates', 'old-source-view');
});
it('does not advertise a retained scene as another loading copy of the current inspection', () => {
  expect(isRegisteredStructureAgentVisible(candidate('current'))).toBe(true);
  expect(isRegisteredStructureAgentVisible(candidate('retained'))).toBe(false);
});
it('keeps a separately opened saved view visible even when its old inspection now shows another scene', () => {
  const canvas = useCanvasStore.getState();
  useCanvasStore.setState({
    panels: {
      main: {
        ...canvas.panels.main,
        tabs: [
          ...canvas.panels.main.tabs,
          {
            id: 'separate-tab',
            type: 'structure',
            entityId: 'retained',
            label: 'Separately opened view',
          },
        ],
      },
    },
  });
  expect(isRegisteredStructureAgentVisible(candidate('retained'))).toBe(true);
});
