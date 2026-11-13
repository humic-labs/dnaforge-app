import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mainIndex = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
const preloadIndex = readFileSync(resolve(__dirname, '../../preload/index.ts'), 'utf8');

describe('preload runtime profile arguments', () => {
  it('passes narrow E2E runtime markers from main to the sandboxed preload', () => {
    expect(mainIndex).toContain('getPreloadRuntimeArguments');
    expect(mainIndex).toContain('additionalArguments: getPreloadRuntimeArguments()');
    expect(mainIndex).toContain('--waypoint-e2e=1');
    expect(mainIndex).toContain('--waypoint-test=1');
    expect(mainIndex).toContain('--dnaforge-allow-scenario-mutation=1');
  });

  it('propagates either accepted E2E marker into the renderer harness query', () => {
    expect(mainIndex).toContain(
      "process.argv.includes('--e2e') || process.argv.includes('--waypoint-e2e=1')"
    );
    expect(mainIndex).toContain("const querySearch = e2eArg ? 'e2e=true' : undefined");
  });

  it('uses the shared runtime contract for physical-profile approval', () => {
    expect(preloadIndex).toContain('createElectronRuntimeProfile(process.argv, process.env)');
  });

  it('exposes main-process runtime provenance through preload IPC', () => {
    expect(preloadIndex).toContain('getProvenance: (): Promise<RuntimeProvenance>');
    expect(preloadIndex).toContain("rendererIpc.invoke('runtime:getProvenance')");
  });
});
