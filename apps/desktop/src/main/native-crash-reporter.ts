import { app } from 'electron';
import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { reportBootOrCrashFailure } from './diagnostics-upload';

export { startNativeCrashReporter } from './native-crash-reporter-start';

export function selectNewNativeDumps(
  dumps: Array<{ name: string; mtimeMs: number }>,
  lastSeenMs: number
): { newDumps: string[]; newMarkerMs: number } {
  const newDumps = dumps.filter((d) => d.mtimeMs > lastSeenMs).map((d) => d.name);
  const newMarkerMs = dumps.reduce((max, d) => Math.max(max, d.mtimeMs), lastSeenMs);
  return { newDumps, newMarkerMs };
}

function collectDumpFiles(dir: string): Array<{ name: string; mtimeMs: number }> {
  const out: Array<{ name: string; mtimeMs: number }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectDumpFiles(full));
    } else if (st.isFile() && entry.endsWith('.dmp')) {
      out.push({ name: full, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

export function reportPriorNativeCrashes(): void {
  try {
    const dir = app.getPath('crashDumps');
    const markerPath = join(app.getPath('userData'), '.native-crash-marker');

    let lastSeen = 0;
    try {
      lastSeen = Number(readFileSync(markerPath, 'utf8')) || 0;
    } catch {}

    const dumps = collectDumpFiles(dir);
    const { newDumps, newMarkerMs } = selectNewNativeDumps(dumps, lastSeen);
    if (newDumps.length > 0) {
      reportBootOrCrashFailure('native_crash', 'crash', `native_minidump_x${newDumps.length}`);
    }
    writeFileSync(markerPath, String(newMarkerMs));
  } catch {}
}
