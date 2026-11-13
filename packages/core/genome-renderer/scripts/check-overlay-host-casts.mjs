#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT_DIR = import.meta.dirname;
const DEFAULT_OVERLAY_DIR = resolve(SCRIPT_DIR, '../src/renderers/pixi/overlays');
const DEFAULT_OVERLAY_FILE = resolve(DEFAULT_OVERLAY_DIR, 'annotation-overlay.ts');

export const HOST_CAST_CEILING = 0;
export const SIBLING_HOST_CAST_CEILING = 22;

const HOST_CAST = 'as unknown as';

export function countHostCasts(source) {
  if (!source) return 0;
  return source.split(HOST_CAST).length - 1;
}

export function overlayProductionFiles(dir = DEFAULT_OVERLAY_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => resolve(dir, name));
}

export function checkOverlayHostCasts(file = DEFAULT_OVERLAY_FILE, ceiling = HOST_CAST_CEILING) {
  const source = readFileSync(file, 'utf8');
  const count = countHostCasts(source);
  return {
    file,
    count,
    ceiling,
    ok: count <= ceiling,
    shouldLowerCeiling: count < ceiling,
  };
}

export function checkOverlaySiblingHostCasts(
  dir = DEFAULT_OVERLAY_DIR,
  ceiling = SIBLING_HOST_CAST_CEILING
) {
  const files = overlayProductionFiles(dir).filter(
    (file) => !file.endsWith('/annotation-overlay.ts')
  );
  let count = 0;
  for (const file of files) {
    count += countHostCasts(readFileSync(file, 'utf8'));
  }
  return {
    dir,
    count,
    ceiling,
    ok: count <= ceiling,
    shouldLowerCeiling: count < ceiling,
  };
}

function runCli() {
  const file = process.env.OVERLAY_HOST_CAST_FILE
    ? resolve(process.env.OVERLAY_HOST_CAST_FILE)
    : DEFAULT_OVERLAY_FILE;
  const result = checkOverlayHostCasts(file);

  console.log(`[overlay-host-casts] count=${result.count} ceiling=${result.ceiling}`);

  if (!result.ok) {
    console.log(
      `[overlay-host-casts] FAIL — ${result.count} > ${result.ceiling}; host-casts may only fall`
    );
    process.exit(1);
  }

  if (result.shouldLowerCeiling) {
    console.log(
      `[overlay-host-casts] HINT — count fell to ${result.count}; lower HOST_CAST_CEILING from ${result.ceiling}`
    );
  }

  if (!process.env.OVERLAY_HOST_CAST_FILE) {
    const siblings = checkOverlaySiblingHostCasts();
    console.log(
      `[overlay-host-casts] siblings=${siblings.count} siblingCeiling=${siblings.ceiling}`
    );
    if (!siblings.ok) {
      console.log(
        `[overlay-host-casts] FAIL — sibling ${siblings.count} > ${siblings.ceiling}; host-casts may only fall`
      );
      process.exit(1);
    }
    if (siblings.shouldLowerCeiling) {
      console.log(
        `[overlay-host-casts] HINT — sibling count fell to ${siblings.count}; lower SIBLING_HOST_CAST_CEILING from ${siblings.ceiling}`
      );
    }
  }

  console.log('[overlay-host-casts] PASS');
  process.exit(0);
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runCli();
}
