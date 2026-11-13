import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { EmptyLoci, type Loci } from 'molstar/lib/mol-model/loci';
import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { installViewerSelectionInteractions, rememberViewerOverview } from './viewerSelection';

function viewer() {
  const click = new Subject<{
    button: number;
    current: { loci: Loci };
    modifiers: Record<string, boolean>;
  }>();
  const snapshot = { position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0] };
  const plugin = molstarPluginFixture({
    isBusy: false,
    behaviors: { interaction: { click } },
    managers: {
      snapshot: { current: { snapshot: { id: 'initial' } } },
      structure: { hierarchy: { current: { structures: [] } }, focus: { clear: vi.fn() } },
      interactivity: {
        lociSelects: { deselectAll: vi.fn() },
        lociHighlights: { clearHighlights: vi.fn() },
      },
    },
    canvas3d: {
      camera: { getSnapshot: () => structuredClone(snapshot), setState: vi.fn() },
      requestCameraReset: vi.fn(),
    },
  });
  installViewerSelectionInteractions(plugin);
  return { plugin, click, snapshot };
}
const blank = { button: 1, current: { loci: EmptyLoci }, modifiers: {} };

describe('native empty-canvas selection interactions', () => {
  it('clears native selection and restores the overview retained across successive targets', () => {
    const { plugin, click, snapshot } = viewer();
    rememberViewerOverview(plugin);
    snapshot.position[2] = 10;
    rememberViewerOverview(plugin);
    click.next(blank);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).toHaveBeenCalledOnce();
    expect(plugin.managers.structure.focus.clear).toHaveBeenCalledOnce();
    expect(plugin.canvas3d.camera.setState).toHaveBeenCalledWith(
      expect.objectContaining({ position: [0, 0, 100] }),
      250
    );
    expect(plugin.canvas3d.requestCameraReset).not.toHaveBeenCalled();
  });
  it('uses native full fit when the remembered view has changed', () => {
    const { plugin, click } = viewer();
    rememberViewerOverview(plugin);
    plugin.managers.snapshot.current.snapshot.id = 'next';
    click.next(blank);
    expect(plugin.canvas3d.camera.setState).not.toHaveBeenCalled();
    expect(plugin.canvas3d.requestCameraReset).toHaveBeenCalledWith({ durationMs: 250 });
  });
  it('leaves structure clicks, right clicks, modified clicks, and busy loads alone', () => {
    const { plugin, click } = viewer();
    click.next({ ...blank, button: 2 });
    for (const key of ['alt', 'control', 'meta', 'shift'])
      click.next({ ...blank, modifiers: { [key]: true } });
    click.next({ ...blank, current: { loci: { kind: 'every-loci' } } });
    plugin.isBusy = true;
    click.next(blank);
    expect(plugin.managers.interactivity.lociSelects.deselectAll).not.toHaveBeenCalled();
    expect(plugin.canvas3d.requestCameraReset).not.toHaveBeenCalled();
  });
});
