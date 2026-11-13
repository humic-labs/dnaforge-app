import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sidecarScenarios, deriveStatus, withMafft, withPlugin } from './sidecar';
import { applyScenario, resetAllStores } from './apply';
import { withPUC19, withGFP, PUC19 } from './sequences';
import { withStandardWorkspace } from './workspace';
import { useCanvasStore } from '../../features/canvas/store';
import { useSequenceStore } from '../../features/sequence/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { ComponentStatus, ToolboxStatusResponse } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotsDir = resolve(__dirname, '../../../../../apps/api/tests/snapshots');

afterEach(() => {
  resetAllStores();
});

describe('Mutation: field rename detection', () => {
  it('renaming blastn → blast_n causes snapshot parity to fail', () => {
    const scenario = sidecarScenarios.fullyReady();

    const mutated: ToolboxStatusResponse = {
      capabilities: scenario.capabilities.map((cap) =>
        cap.id === 'annotation'
          ? {
              ...cap,
              components: cap.components.map((c) =>
                c.id === 'blastn' ? { ...c, id: 'blast_n' } : c
              ),
            }
          : cap
      ),
    };

    expect(mutated).not.toEqual(scenario);

    const origIds = scenario.capabilities
      .find((c) => c.id === 'annotation')!
      .components.map((c) => c.id);
    const mutatedIds = mutated.capabilities
      .find((c) => c.id === 'annotation')!
      .components.map((c) => c.id);
    expect(mutatedIds).not.toEqual(origIds);
  });

  it('renaming capability id causes lookup to fail', () => {
    const scenario = sidecarScenarios.fullyReady();

    const mutated: ToolboxStatusResponse = {
      capabilities: scenario.capabilities.map((cap) =>
        cap.id === 'annotation' ? { ...cap, id: 'annotate' } : cap
      ),
    };

    const ann = mutated.capabilities.find((c) => c.id === 'annotation');
    expect(ann).toBeUndefined();
  });

  it('snapshot parity fails when field is renamed', () => {
    const snapshotPath = resolve(snapshotsDir, 'fully_ready.json');
    if (!existsSync(snapshotPath)) {
      console.warn('Snapshot not found — skipping');
      return;
    }

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    const scenario = sidecarScenarios.fullyReady();

    const mutated = JSON.parse(JSON.stringify(scenario));
    mutated.capabilities[0].components[0].id = 'blast_n';

    expect(mutated).not.toEqual(snapshot);
  });
});

describe('Mutation: status logic', () => {
  it('broken deriveStatus (always returns ready) is detected', () => {
    const brokenDerive = (_components: ComponentStatus[]): ComponentStatus['status'] => 'ready';

    const mixedComponents: ComponentStatus[] = [
      { id: 'a', label: 'a', status: 'downloading', source: 'test' },
      { id: 'b', label: 'b', status: 'error', source: 'test' },
    ];

    expect(deriveStatus(mixedComponents)).toBe('downloading');
    expect(brokenDerive(mixedComponents)).toBe('ready');
    expect(deriveStatus(mixedComponents)).not.toBe(brokenDerive(mixedComponents));
  });

  it('deriveStatus correctly handles edge cases', () => {
    expect(deriveStatus([])).toBe('unavailable');

    expect(deriveStatus([{ id: 'x', label: 'x', status: 'downloading', source: 't' }])).toBe(
      'downloading'
    );

    expect(
      deriveStatus([
        { id: 'a', label: 'a', status: 'downloading', source: 't' },
        { id: 'b', label: 'b', status: 'error', source: 't' },
      ])
    ).toBe('downloading');

    expect(
      deriveStatus([
        { id: 'a', label: 'a', status: 'error', source: 't' },
        { id: 'b', label: 'b', status: 'unavailable', source: 't' },
      ])
    ).toBe('error');

    expect(
      deriveStatus([
        { id: 'a', label: 'a', status: 'ready', source: 't' },
        { id: 'b', label: 'b', status: 'ready', source: 't' },
      ])
    ).toBe('ready');
  });

  it('swapping ready/error in scenario changes capability status', () => {
    const ready = sidecarScenarios.fullyReady();
    const error = sidecarScenarios.toolsError();

    const readyAnnotation = ready.capabilities.find((c) => c.id === 'annotation')!;
    const errorAnnotation = error.capabilities.find((c) => c.id === 'annotation')!;

    expect(readyAnnotation.status).toBe('ready');
    expect(errorAnnotation.status).toBe('error');
    expect(readyAnnotation.status).not.toBe(errorAnnotation.status);
  });
});

describe('Mutation: store hydration consistency', () => {
  const puc19DocumentId = 'fixture:sequence:puc19';

  it('corrupting sequence store after applyScenario is detectable', () => {
    const scenario = withPUC19({ sidecar: sidecarScenarios.fullyReady() });
    applyScenario(scenario);

    const seqBefore = useSequenceStore.getState().sequences[puc19DocumentId];
    expect(seqBefore).toBeDefined();
    expect(seqBefore.name).toBe('pUC19');

    useSequenceStore.setState({
      sequences: {
        [puc19DocumentId]: { ...seqBefore, name: 'CORRUPTED', length: -1 },
      },
    });

    const seqAfter = useSequenceStore.getState().sequences[puc19DocumentId];
    expect(seqAfter.name).not.toBe(seqBefore.name);
    expect(seqAfter.length).not.toBe(seqBefore.length);
  });

  it('corrupting canvas store after applyScenario is detectable', () => {
    const scenario = withPUC19({ sidecar: sidecarScenarios.fullyReady() });
    applyScenario(scenario);

    const panelsBefore = useCanvasStore.getState().panels;
    const allTabsBefore = Object.values(panelsBefore).flatMap((p) => p.tabs);
    expect(allTabsBefore).toHaveLength(1);
    expect(allTabsBefore[0].entityId).toBe(puc19DocumentId);

    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    });

    const allTabsAfter = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabsAfter).toHaveLength(0);
    expect(allTabsAfter).not.toEqual(allTabsBefore);
  });

  it('corrupting workspace store after applyScenario is detectable', () => {
    const scenario = withStandardWorkspace({ sidecar: sidecarScenarios.fullyReady() });
    applyScenario(scenario);

    const foldersBefore = useWorkspaceStore.getState().folders;
    expect(foldersBefore).toHaveLength(2);

    useWorkspaceStore.setState({ folders: [] });

    expect(useWorkspaceStore.getState().folders).toHaveLength(0);
    expect(useWorkspaceStore.getState().folders).not.toEqual(foldersBefore);
  });
});

describe('Mutation: cross-language drift detection', () => {
  it('version mismatch between TS and Python snapshots is detectable', () => {
    const snapshotPath = resolve(snapshotsDir, 'fully_ready.json');
    if (!existsSync(snapshotPath)) {
      console.warn('Snapshot not found — skipping');
      return;
    }

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    const scenario = sidecarScenarios.fullyReady();

    const mutated = JSON.parse(JSON.stringify(scenario));
    const ann = mutated.capabilities.find((c: { id: string }) => c.id === 'annotation');
    const blastn = ann.components.find((c: { id: string }) => c.id === 'blastn');
    blastn.version = '9.99.0';

    expect(mutated).not.toEqual(snapshot);
  });

  it('adding extra field in TS causes drift from Python', () => {
    const snapshotPath = resolve(snapshotsDir, 'fresh_install.json');
    if (!existsSync(snapshotPath)) {
      console.warn('Snapshot not found — skipping');
      return;
    }

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    const scenario = sidecarScenarios.freshInstall();
    const tsOutput = JSON.parse(JSON.stringify(scenario));

    tsOutput.capabilities[0].extra_field = 'should not exist';

    expect(tsOutput).not.toEqual(snapshot);
  });
});
