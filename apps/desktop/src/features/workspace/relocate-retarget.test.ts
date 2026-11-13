// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvas/store';

const tab = (over: { id: string; entityId: string; label: string; type?: string }) => ({
  id: over.id,
  type: (over.type ?? 'sequence') as never,
  entityId: over.entityId,
  label: over.label,
});
describe('canvas retargetTabsUnderPath', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 't1',
          tabs: [
            tab({ id: 't1', entityId: 'sequence-document-1', label: 'old.gb' }),
            tab({ id: 't2', entityId: '/w/dir/notes.txt', label: 'notes.txt', type: 'text' }),
            tab({ id: 't3', entityId: 'conv-123', label: 'Chat', type: 'chat' }),
          ],
        },
      },
    } as never);
  });

  it('(a) never rewrites a logical sequence document ID', () => {
    useCanvasStore.getState().retargetTabsUnderPath('/w/old.gb', '/w/moved/new.gb');
    const t = useCanvasStore.getState().panels.main.tabs.find((x) => x.id === 't1')!;
    expect(t.entityId).toBe('sequence-document-1');
    expect(t.label).toBe('old.gb');
  });

  it('(b) prefix-rebases a path-backed text tab and leaves logical IDs alone', () => {
    useCanvasStore.getState().retargetTabsUnderPath('/w/dir', '/w/renamed');
    const tabs = useCanvasStore.getState().panels.main.tabs;
    expect(tabs.find((x) => x.id === 't2')!.entityId).toBe('/w/renamed/notes.txt');
    expect(tabs.find((x) => x.id === 't1')!.entityId).toBe('sequence-document-1');
    expect(tabs.find((x) => x.id === 't3')!.entityId).toBe('conv-123');
  });

  it('(c) preserves a CUSTOM label (only auto basename labels retitle)', () => {
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 't1',
          tabs: [tab({ id: 't1', entityId: '/w/old.txt', label: 'My Notes', type: 'text' })],
        },
      },
    } as never);
    useCanvasStore.getState().retargetTabsUnderPath('/w/old.txt', '/w/new.txt');
    const t = useCanvasStore.getState().panels.main.tabs[0];
    expect(t.entityId).toBe('/w/new.txt');
    expect(t.label).toBe('My Notes');
  });

  it('retargets the persisted primer editor locator with its open tab', () => {
    const oldPath = '/w/primers/Construction/original.primer.json';
    const newPath = '/w/primers/Construction/renamed.primer.json';
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 'primer-tab',
          tabs: [
            {
              ...tab({
                id: 'primer-tab',
                entityId: oldPath,
                label: 'Construction oligo',
                type: 'primer',
              }),
              artifactDocument: {
                kind: 'primer',
                persistence: 'persisted',
                workspaceRoot: '/w',
                destinationPath: '/w/primers/Construction',
                artifactPath: oldPath,
              },
            },
          ],
        },
      },
    } as never);

    useCanvasStore.getState().retargetTabsUnderPath(oldPath, newPath);
    const primerTab = useCanvasStore.getState().panels.main.tabs[0];
    expect(primerTab.entityId).toBe(newPath);
    expect(primerTab.label).toBe('Construction oligo');
    expect(primerTab.artifactDocument).toEqual({
      kind: 'primer',
      persistence: 'persisted',
      workspaceRoot: '/w',
      destinationPath: '/w/primers/Construction',
      artifactPath: newPath,
    });
  });
});
