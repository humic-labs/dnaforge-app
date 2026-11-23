import { Graphics } from 'pixi.js';
import type { PixiLinearTrackRenderer, SupplementalLinearTrack } from '@waypoint/genome-renderer';

import type { ReadTrackRow } from '../view-state/read-track-layout';

const groupHeader: PixiLinearTrackRenderer = {
  type: 'track-group-header',
  mount: () => new Graphics(),
  paint({ container, layoutEntry, viewportWidthPx, theme }) {
    const graphics = container as Graphics;
    graphics.clear();
    graphics
      .rect(0, 0, viewportWidthPx, layoutEntry.height)
      .fill({ color: theme.mode === 'dark' ? 0xffffff : 0x17212b, alpha: 0.045 });
  },
  unmount: (container) => container.destroy(),
};

export function createGroupHeaderBindings() {
  let previous = new Map<string, SupplementalLinearTrack>();
  return (rows: readonly ReadTrackRow[], assemblyId: string) => {
    const bindings: SupplementalLinearTrack[] = [];
    let order = 0;
    for (const row of rows) {
      if (row.kind === 'group') {
        const cached = previous.get(row.id);
        bindings.push(
          cached?.track.order === order && cached.track.assemblyId === assemblyId
            ? cached
            : {
                track: {
                  id: row.id,
                  order,
                  visible: true,
                  assemblyId,
                  type: groupHeader.type,
                  zone: 'below-legacy',
                  sizing: { kind: 'fixed', pixels: 28 },
                },
                data: null,
                renderer: groupHeader,
              }
        );
        order += row.trackIds.length;
      }
      order++;
    }
    previous = new Map(bindings.map((binding) => [binding.track.id, binding]));
    return bindings;
  };
}
