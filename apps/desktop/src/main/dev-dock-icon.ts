import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { app, nativeImage, type NativeImage } from 'electron';

import {
  badgeLabelIsEmpty,
  composeBadgeIcon,
  computeBadgeIconLayout,
  deriveBadgeLabel,
  shouldBadgeDockIcon,
  type BadgeLabel,
} from './dev-dock-badge';
import { RELEASE_BUILD_IDENTITY } from './release-stamp';
import { normalizeDevInstanceLabel } from '../shared/dev-window-identity';

export const DEV_DOCK_BADGE_ENV_NAME = 'DNAFORGE_DEV_DOCK_BADGE';

export const DEV_DOCK_BADGE_DUMP_ENV_NAME = 'DNAFORGE_DEV_DOCK_BADGE_DUMP';

const BADGED_ICON_SIZE = 512;

const bakedBadgeLabel =
  typeof __DNAFORGE_DEV_BADGE_LABEL__ === 'string' ? __DNAFORGE_DEV_BADGE_LABEL__ : '';

export function baseIconCandidates(appPath: string, resourcesPath: string): string[] {
  return [
    join(resourcesPath, 'icon.png'),
    join(appPath, 'resources', 'icon.png'),
    join(appPath, '..', 'resources', 'icon.png'),
    join(appPath, '..', '..', 'apps', 'desktop', 'resources', 'icon.png'),
    join(resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png'),
  ];
}

function loadBaseIcon(appPath: string, resourcesPath: string): NativeImage | null {
  for (const candidate of baseIconCandidates(appPath, resourcesPath)) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return null;
}

function gitLabel(cwd: string): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    let worktreeBase = basename(cwd);
    try {
      worktreeBase = basename(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      );
    } catch {}
    return normalizeDevInstanceLabel(branch, worktreeBase, 64);
  } catch {
    return '';
  }
}

export interface ResolveBadgeLabelInput {
  appPath: string;
  port: string | number | null | undefined;
  packaged: boolean;
}

export function resolveBadgeLabel(input: ResolveBadgeLabelInput): BadgeLabel {
  const live = input.packaged ? '' : gitLabel(input.appPath);
  return deriveBadgeLabel({
    label: live !== '' ? live : bakedBadgeLabel,
    port: input.port,
    packaged: input.packaged,
  });
}

export function badgeIcon(base: NativeImage | null, label: BadgeLabel): NativeImage | null {
  const size = BADGED_ICON_SIZE;
  const layout = computeBadgeIconLayout(size, size, label);
  if (layout === null) return null;

  let logo: { bitmap: Buffer; width: number; height: number } | null = null;
  if (base !== null && !base.isEmpty()) {
    const resized = base.resize({ width: layout.logo.width, height: layout.logo.height });
    const logoSize = resized.getSize();
    if (logoSize.width > 0 && logoSize.height > 0) {
      logo = { bitmap: resized.toBitmap(), width: logoSize.width, height: logoSize.height };
    }
  }

  const bitmap = Buffer.alloc(size * size * 4, 0);
  if (!composeBadgeIcon(bitmap, size, size, label, logo)) return null;
  const badged = nativeImage.createFromBuffer(bitmap, { width: size, height: size });
  return badged.isEmpty() ? null : badged;
}

export type DevDockBadgeResult =
  | 'applied'
  | 'skipped-release'
  | 'skipped-disabled'
  | 'skipped-no-identity'
  | 'skipped-no-dock'
  | 'failed';

export interface ApplyDevDockBadgeOptions {
  port: string | number | null | undefined;
}

export function applyDevDockBadge(options: ApplyDevDockBadgeOptions): DevDockBadgeResult {
  if (RELEASE_BUILD_IDENTITY.isReleaseBuild) return 'skipped-release';
  if (
    !shouldBadgeDockIcon({ isReleaseBuild: false, badgeEnv: process.env[DEV_DOCK_BADGE_ENV_NAME] })
  ) {
    return 'skipped-disabled';
  }

  const dock = app.dock;
  if (!dock) return 'skipped-no-dock';

  try {
    const label = resolveBadgeLabel({
      appPath: app.getAppPath(),
      port: options.port,
      packaged: app.isPackaged,
    });
    if (badgeLabelIsEmpty(label)) return 'skipped-no-identity';

    const base = loadBaseIcon(app.getAppPath(), process.resourcesPath);
    const badged = badgeIcon(base, label);
    if (!badged) return 'failed';
    dock.setIcon(badged);

    const dumpPath = (process.env[DEV_DOCK_BADGE_DUMP_ENV_NAME] ?? '').trim();
    if (dumpPath !== '') {
      try {
        mkdirSync(dirname(dumpPath), { recursive: true });
        writeFileSync(dumpPath, badged.toPNG());
      } catch {}
    }
    return 'applied';
  } catch {
    return 'failed';
  }
}
