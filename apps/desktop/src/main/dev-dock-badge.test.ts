import { describe, expect, it } from 'vitest';

import {
  badgeLabelIsEmpty,
  composeBadgeIcon,
  computeBadgeIconLayout,
  deriveBadgeLabel,
  drawGlyphText,
  GLYPH_HEIGHT,
  measureGlyphText,
  shouldBadgeDockIcon,
  wrapWords,
  BADGE_DEV_TAG,
  BADGE_FOREGROUND,
  BADGE_PACKAGED_TAG,
  runtimeLineText,
  type BadgeLabel,
} from './dev-dock-badge';

function blankBitmap(width: number, height: number): Buffer {
  return Buffer.alloc(width * height * 4, 0);
}

function inkPixelCount(bitmap: Buffer): number {
  let count = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (bitmap[offset + 3] !== 0) count += 1;
  }
  return count;
}

const REAL_WORKTREE = 'TASK-2273-toolchain-single-source';

describe('deriveBadgeLabel', () => {
  it('splits a real worktree name into ticket, words, and port', () => {
    expect(deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 })).toEqual<BadgeLabel>({
      runtime: 'dev',
      headline: '2273',
      words: ['TOOLCHAIN', 'SINGLE', 'SOURCE'],
      port: '1451',
    });
  });

  it('strips branch and repo prefixes', () => {
    expect(deriveBadgeLabel({ label: 'feature/TASK-2273-toolchain', port: null }).headline).toBe(
      '2273'
    );
    expect(deriveBadgeLabel({ label: 'waypoint-TASK-2273-toolchain', port: null }).headline).toBe(
      '2273'
    );
    expect(deriveBadgeLabel({ label: 'fix/TASK-708-blank', port: null }).headline).toBe('708');
  });

  it('still badges a packaged build that has no port', () => {
    const label = deriveBadgeLabel({ label: REAL_WORKTREE, port: null });
    expect(label.port).toBeNull();
    expect(label.headline).toBe('2273');
    expect(badgeLabelIsEmpty(label)).toBe(false);
  });

  it('still badges a dev server whose worktree has no ticket', () => {
    const label = deriveBadgeLabel({ label: 'spike-human-genome-merge-a', port: 1433 });
    expect(label.headline).toBeNull();
    expect(label.words).toEqual(['SPIKE', 'HUMAN', 'GENOME', 'MERGE', 'A']);
    expect(label.port).toBe('1433');
  });

  it('promotes a leading numeric token to the headline when there is no ticket', () => {
    const label = deriveBadgeLabel({ label: '708b.3', port: 1436 });
    expect(label.headline).toBe('708B');
    expect(label.words).toEqual(['3']);
  });

  it('strips characters the font cannot draw, rather than rendering them as "?"', () => {
    const label = deriveBadgeLabel({ label: 'TASK-2285-some-very-long-nam\u2026', port: 1432 });
    for (const word of label.words) {
      expect(word).toMatch(/^[A-Z0-9:+/.-]+$/);
    }
    expect(label.words.join(' ')).not.toContain('\u2026');
    expect(label.headline).toBe('2285');
  });

  it('is empty only when there is genuinely nothing to say', () => {
    expect(badgeLabelIsEmpty(deriveBadgeLabel({ label: '', port: null }))).toBe(true);
    expect(badgeLabelIsEmpty(deriveBadgeLabel({ label: null, port: undefined }))).toBe(true);
    expect(badgeLabelIsEmpty(deriveBadgeLabel({ label: '', port: 1420 }))).toBe(false);
  });
});

describe('shouldBadgeDockIcon', () => {
  it('never badges a release build, even when the env var asks for it', () => {
    expect(shouldBadgeDockIcon({ isReleaseBuild: true, badgeEnv: '1' })).toBe(false);
    expect(shouldBadgeDockIcon({ isReleaseBuild: true, badgeEnv: undefined })).toBe(false);
  });

  it('badges every non-release build by default, packaged included', () => {
    expect(shouldBadgeDockIcon({ isReleaseBuild: false, badgeEnv: undefined })).toBe(true);
  });

  it('honours an explicit opt-out', () => {
    for (const value of ['0', 'false', 'off', 'no', 'OFF', ' False ']) {
      expect(shouldBadgeDockIcon({ isReleaseBuild: false, badgeEnv: value })).toBe(false);
    }
  });
});

describe('wrapWords', () => {
  it('wraps to the available width rather than overflowing', () => {
    const scale = 2;
    const maxWidth = measureGlyphText('TOOLCHAIN', scale);
    const lines = wrapWords(['TOOLCHAIN', 'SINGLE', 'SOURCE'], scale, maxWidth);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureGlyphText(line, scale)).toBeLessThanOrEqual(maxWidth);
    }
  });

  it('never drops a word, even one too long to fit', () => {
    const lines = wrapWords(['SUPERCALIFRAGILISTIC'], 4, 10);
    expect(lines).toEqual(['SUPERCALIFRAGILISTIC']);
  });
});

describe('composeBadgeIcon', () => {
  const label = deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 });
  const logo = {
    bitmap: Buffer.alloc(64 * 64 * 4, 200),
    width: 64,
    height: 64,
  };

  it('composes a tile', () => {
    const bitmap = blankBitmap(512, 512);
    expect(composeBadgeIcon(bitmap, 512, 512, label, logo)).toBe(true);
    expect(inkPixelCount(bitmap)).toBeGreaterThan(10000);
  });

  it('draws DIFFERENT pixels for different worktrees — the whole point', () => {
    const a = blankBitmap(512, 512);
    const b = blankBitmap(512, 512);
    composeBadgeIcon(
      a,
      512,
      512,
      deriveBadgeLabel({ label: 'TASK-2273-toolchain', port: 1451 }),
      logo
    );
    composeBadgeIcon(b, 512, 512, deriveBadgeLabel({ label: 'TASK-2241-pileup', port: 1439 }), logo);
    expect(a.equals(b)).toBe(false);
  });

  it('distinguishes two worktrees that differ ONLY by port', () => {
    const a = blankBitmap(512, 512);
    const b = blankBitmap(512, 512);
    composeBadgeIcon(a, 512, 512, deriveBadgeLabel({ label: 'TASK-2273-x', port: 1455 }), logo);
    composeBadgeIcon(b, 512, 512, deriveBadgeLabel({ label: 'TASK-2273-x', port: 1456 }), logo);
    expect(a.equals(b)).toBe(false);
  });

  it('is deterministic', () => {
    const a = blankBitmap(512, 512);
    const b = blankBitmap(512, 512);
    composeBadgeIcon(a, 512, 512, label, logo);
    composeBadgeIcon(b, 512, 512, label, logo);
    expect(a.equals(blankBitmap(512, 512))).toBe(false);
    expect(a.equals(b)).toBe(true);
  });

  it('still produces a readable tile when the artwork cannot be loaded', () => {
    const bitmap = blankBitmap(512, 512);
    expect(composeBadgeIcon(bitmap, 512, 512, label, null)).toBe(true);
    expect(inkPixelCount(bitmap)).toBeGreaterThan(10000);
  });

  it('refuses an empty label rather than painting a blank tile', () => {
    const bitmap = blankBitmap(512, 512);
    expect(
      composeBadgeIcon(bitmap, 512, 512, deriveBadgeLabel({ label: '', port: null }), logo)
    ).toBe(false);
    expect(inkPixelCount(bitmap)).toBe(0);
  });

  it('leaves the tile corners transparent so it still reads as an app icon', () => {
    const bitmap = blankBitmap(512, 512);
    composeBadgeIcon(bitmap, 512, 512, label, logo);
    expect(bitmap[0 * 4 + 3]).toBe(0);
  });

  it('does not throw on a degenerate image', () => {
    const bitmap = blankBitmap(4, 4);
    expect(() => composeBadgeIcon(bitmap, 4, 4, label, logo)).not.toThrow();
    expect(() => composeBadgeIcon(bitmap, 0, 0, label, logo)).not.toThrow();
  });
});

describe('computeBadgeIconLayout', () => {
  const label = deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 });

  it('puts the logo top-left and the ticket to its right', () => {
    const layout = computeBadgeIconLayout(512, 512, label);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    expect(layout.logo.x).toBeLessThan(512 / 2);
    expect(layout.logo.y).toBeLessThan(512 / 2);
    expect(layout.headline?.text).toBe('2273');
    expect(layout.headline?.originX ?? 0).toBeGreaterThanOrEqual(layout.logo.x + layout.logo.width);
  });

  it('gives the worktree name the bottom half at a LARGER scale than before', () => {
    const layout = computeBadgeIconLayout(512, 512, label);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    const firstBody = layout.body[0];
    expect(firstBody).toBeDefined();
    expect(firstBody?.scale ?? 0).toBeGreaterThan(4);
    expect(firstBody?.originY ?? 0).toBeGreaterThanOrEqual(Math.round(512 * 0.44));
  });

  it('keeps every line inside the tile at each size we might be handed', () => {
    for (const size of [128, 256, 512, 1024]) {
      const layout = computeBadgeIconLayout(size, size, label);
      expect(layout).not.toBeNull();
      if (layout === null) continue;
      const all = layout.headline === null ? layout.body : [layout.headline, ...layout.body];
      for (const line of all) {
        expect(line.originX).toBeGreaterThanOrEqual(0);
        expect(line.originX + measureGlyphText(line.text, line.scale)).toBeLessThanOrEqual(size);
        expect(line.originY).toBeGreaterThanOrEqual(0);
        expect(line.originY + GLYPH_HEIGHT * line.scale).toBeLessThanOrEqual(size);
      }
      expect(layout.logo.x + layout.logo.width).toBeLessThanOrEqual(size);
      expect(layout.logo.y + layout.logo.height).toBeLessThanOrEqual(size);
    }
  });

  it('keeps EVERY word of a real worktree name — none silently dropped', () => {
    const label = deriveBadgeLabel({ label: 'TASK-2285-dock-badge-descriptive', port: 1432 });
    const layout = computeBadgeIconLayout(512, 512, label);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    const rendered = layout.body
      .filter((line) => !line.text.startsWith(':'))
      .join(' ')
      .replace(/,/g, ' ');
    for (const word of label.words) {
      expect(layout.body.some((line) => line.text.includes(word))).toBe(true);
    }
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('never lets a long word run off the tile edge', () => {
    for (const name of [
      'TASK-2285-dock-badge-descriptive',
      'TASK-1919-annotation-generation-command',
      'TASK-2260-indexed-genome-actionable-views',
    ]) {
      const layout = computeBadgeIconLayout(
        512,
        512,
        deriveBadgeLabel({ label: name, port: 1432 })
      );
      expect(layout).not.toBeNull();
      if (layout === null) continue;
      for (const line of layout.body) {
        expect(line.originX).toBeGreaterThanOrEqual(0);
        expect(line.originX + measureGlyphText(line.text, line.scale)).toBeLessThanOrEqual(512);
      }
    }
  });

  it('shows the runtime + port last and dimmer than the name', () => {
    const layout = computeBadgeIconLayout(512, 512, label);
    const last = layout?.body[(layout?.body.length ?? 1) - 1];
    expect(last?.text).toBe(':1451');
    expect(last?.color).not.toEqual(BADGE_FOREGROUND);
  });

  it('keeps an absurdly long worktree name inside the tile', () => {
    const long = deriveBadgeLabel({
      label: 'TASK-9999-' + Array.from({ length: 25 }, (_, i) => `word${i}`).join('-'),
      port: 1499,
    });
    const layout = computeBadgeIconLayout(512, 512, long);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    for (const line of layout.body) {
      expect(line.originY + GLYPH_HEIGHT * line.scale).toBeLessThanOrEqual(512);
    }
    expect(layout.headline?.text).toBe('9999');
    expect(layout.body[layout.body.length - 1]?.text).toBe(':1499');
    expect(layout.body[layout.body.length - 2]?.text).toBe('DEV');
  });
});

describe('bounds safety', () => {
  it('drops out-of-bounds ink instead of wrapping onto the next row', () => {
    const bitmap = blankBitmap(16, 16);
    drawGlyphText(bitmap, 16, 16, {
      text: 'AB',
      originX: 16 + 40,
      originY: 4,
      scale: 1,
      color: BADGE_FOREGROUND,
    });
    expect(inkPixelCount(bitmap)).toBe(0);
  });

  it('never writes past the end of the buffer', () => {
    const bitmap = blankBitmap(12, 12);
    expect(() =>
      drawGlyphText(bitmap, 12, 12, {
        text: 'WW',
        originX: 10,
        originY: 10,
        scale: 3,
        color: BADGE_FOREGROUND,
      })
    ).not.toThrow();
    expect(bitmap.length).toBe(12 * 12 * 4);
  });

  it('renders an unknown character as the fallback rather than nothing', () => {
    const known = blankBitmap(64, 32);
    const unknown = blankBitmap(64, 32);
    drawGlyphText(known, 64, 32, {
      text: '?',
      originX: 2,
      originY: 2,
      scale: 2,
      color: BADGE_FOREGROUND,
    });
    drawGlyphText(unknown, 64, 32, {
      text: 'é',
      originX: 2,
      originY: 2,
      scale: 2,
      color: BADGE_FOREGROUND,
    });
    expect(unknown.equals(known)).toBe(true);
  });
});

describe('runtime marker (DEV:port / PKG)', () => {
  const logo = { bitmap: Buffer.alloc(64 * 64 * 4, 200), width: 64, height: 64 };

  it('marks a dev server DEV and a packaged build PKG', () => {
    expect(deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 }).runtime).toBe('dev');
    expect(deriveBadgeLabel({ label: REAL_WORKTREE, port: null, packaged: true }).runtime).toBe(
      'packaged'
    );
  });

  it('reads DEV:1451 for a dev server and PKG for a packaged build', () => {
    expect(runtimeLineText(deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 }))).toBe(
      'DEV:1451'
    );
    expect(
      runtimeLineText(deriveBadgeLabel({ label: REAL_WORKTREE, port: null, packaged: true }))
    ).toBe('PKG');
  });

  it('puts the marker and the port on ONE baseline, marker coloured, port muted', () => {
    const layout = computeBadgeIconLayout(
      512,
      512,
      deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 })
    );
    expect(layout).not.toBeNull();
    if (layout === null) return;
    const port = layout.body[layout.body.length - 1];
    const tag = layout.body[layout.body.length - 2];
    expect(tag?.text).toBe('DEV');
    expect(port?.text).toBe(':1451');
    expect(tag?.originY).toBe(port?.originY);
    expect(tag?.color).toEqual(BADGE_DEV_TAG);
    expect(port?.color).not.toEqual(BADGE_DEV_TAG);
    expect(port?.originX ?? 0).toBeGreaterThan(tag?.originX ?? 0);
  });

  it('emits no port run at all for a packaged build', () => {
    const layout = computeBadgeIconLayout(
      512,
      512,
      deriveBadgeLabel({ label: REAL_WORKTREE, port: null, packaged: true })
    );
    const last = layout?.body[(layout?.body.length ?? 1) - 1];
    expect(last?.text).toBe('PKG');
    expect(last?.color).toEqual(BADGE_PACKAGED_TAG);
  });

  it('draws a visibly different tile for dev vs packaged, same worktree', () => {
    const a = blankBitmap(512, 512);
    const b = blankBitmap(512, 512);
    composeBadgeIcon(a, 512, 512, deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 }), logo);
    composeBadgeIcon(
      b,
      512,
      512,
      deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451, packaged: true }),
      logo
    );
    expect(a.equals(b)).toBe(false);
  });

  it('does not treat the marker alone as an identity', () => {
    expect(badgeLabelIsEmpty(deriveBadgeLabel({ label: '', port: null, packaged: false }))).toBe(
      true
    );
  });
});

describe('composition is one centred block', () => {
  const label = deriveBadgeLabel({ label: REAL_WORKTREE, port: 1451 });

  it('does not strand the name far below the logo', () => {
    const layout = computeBadgeIconLayout(512, 512, label);
    expect(layout).not.toBeNull();
    if (layout === null) return;
    const firstBody = layout.body[0];
    const gap = (firstBody?.originY ?? 0) - (layout.logo.y + layout.logo.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(Math.round(512 * 0.08));
  });

  it('keeps the whole assembly inside the tile', () => {
    for (const size of [128, 256, 512, 1024]) {
      const l = computeBadgeIconLayout(size, size, label);
      expect(l).not.toBeNull();
      if (l === null) continue;
      const all = l.headline === null ? l.body : [l.headline, ...l.body];
      for (const line of all) {
        expect(line.originX).toBeGreaterThanOrEqual(0);
        expect(line.originX + measureGlyphText(line.text, line.scale)).toBeLessThanOrEqual(size);
        expect(line.originY).toBeGreaterThanOrEqual(0);
        expect(line.originY + GLYPH_HEIGHT * line.scale).toBeLessThanOrEqual(size);
      }
      expect(l.logo.y).toBeGreaterThanOrEqual(0);
      expect(l.logo.x + l.logo.width).toBeLessThanOrEqual(size);
    }
  });
});
