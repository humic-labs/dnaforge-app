import { describe, it, expect } from 'vitest';
import { sidecarScenarios, withMafft, withPlugin } from './index';
import type { ToolboxStatusResponse } from './types';

function getCap(scenario: ToolboxStatusResponse, id: string) {
  return scenario.capabilities.find((c) => c.id === id);
}

function getComp(scenario: ToolboxStatusResponse, capId: string, compId: string) {
  const cap = getCap(scenario, capId);
  return cap?.components.find((c) => c.id === compId);
}

describe('sidecarScenarios', () => {
  describe.each([
    ['freshInstall', () => sidecarScenarios.freshInstall()],
    ['fullyReady', () => sidecarScenarios.fullyReady()],
    ['toolsError', () => sidecarScenarios.toolsError()],
    ['downloadingTools', () => sidecarScenarios.downloadingTools(50)],
    ['downloadingDatabases', () => sidecarScenarios.downloadingDatabases(30)],
    ['downloadingAll', () => sidecarScenarios.downloadingAll(25, 60)],
    ['partialReady', () => sidecarScenarios.partialReady(['blastn'])],
  ] as const)('%s', (_, builder) => {
    it('produces valid JSON roundtrip', () => {
      const scenario = builder();
      const json = JSON.stringify(scenario);
      const parsed = JSON.parse(json) as ToolboxStatusResponse;
      expect(parsed).toEqual(scenario);
    });

    it('has annotation capability', () => {
      const scenario = builder();
      expect(getCap(scenario, 'annotation')).toBeDefined();
    });

    it('has all required capability fields', () => {
      const scenario = builder();
      for (const cap of scenario.capabilities) {
        expect(cap.id).toBeDefined();
        expect(cap.label).toBeDefined();
        expect(cap.status).toBeDefined();
        expect(cap.source).toBeDefined();
        expect(cap.tier).toBeDefined();
        expect(typeof cap.auto_install).toBe('boolean');
        expect(Array.isArray(cap.components)).toBe(true);
      }
    });
  });

  describe('freshInstall', () => {
    it('all annotation components unavailable', () => {
      const s = sidecarScenarios.freshInstall();
      const ann = getCap(s, 'annotation')!;
      expect(ann.status).toBe('unavailable');
      for (const comp of ann.components) {
        expect(comp.status).toBe('unavailable');
      }
    });

    it('mafft unavailable', () => {
      const s = sidecarScenarios.freshInstall();
      expect(getComp(s, 'alignment', 'mafft')?.status).toBe('unavailable');
    });
  });

  describe('fullyReady', () => {
    it('all capabilities ready', () => {
      const s = sidecarScenarios.fullyReady();
      for (const cap of s.capabilities) {
        expect(cap.status).toBe('ready');
      }
    });
  });

  describe('downloadingTools', () => {
    it('sets progress percent', () => {
      const s = sidecarScenarios.downloadingTools(45);
      const blastn = getComp(s, 'annotation', 'blastn')!;
      expect(blastn.status).toBe('downloading');
      expect(blastn.progress?.percent).toBe(45);
    });

    it('databases still unavailable', () => {
      const s = sidecarScenarios.downloadingTools();
      expect(getComp(s, 'annotation', 'databases')?.status).toBe('unavailable');
    });
  });

  describe('downloadingDatabases', () => {
    it('tools ready, databases downloading', () => {
      const s = sidecarScenarios.downloadingDatabases(70);
      expect(getComp(s, 'annotation', 'blastn')?.status).toBe('ready');
      const db = getComp(s, 'annotation', 'databases')!;
      expect(db.status).toBe('downloading');
      expect(db.progress?.percent).toBe(70);
    });
  });

  describe('toolsError', () => {
    it('annotation tools in error state', () => {
      const s = sidecarScenarios.toolsError();
      const ann = getCap(s, 'annotation')!;
      expect(ann.status).toBe('error');
    });
  });

  describe('partialReady', () => {
    it('only specified tools are ready', () => {
      const s = sidecarScenarios.partialReady(['blastn', 'diamond']);
      expect(getComp(s, 'annotation', 'blastn')?.status).toBe('ready');
      expect(getComp(s, 'annotation', 'diamond')?.status).toBe('ready');
      expect(getComp(s, 'annotation', 'cmscan')?.status).toBe('unavailable');
    });
  });
});

describe('modifiers', () => {
  describe('withMafft', () => {
    it('makes mafft ready', () => {
      const s = withMafft(sidecarScenarios.freshInstall());
      expect(getComp(s, 'alignment', 'mafft')?.status).toBe('ready');
    });

    it('does not mutate original', () => {
      const original = sidecarScenarios.freshInstall();
      withMafft(original);
      expect(getComp(original, 'alignment', 'mafft')?.status).toBe('unavailable');
    });
  });

  describe('withPlugin', () => {
    it('adds plugin capability', () => {
      const s = withPlugin(sidecarScenarios.fullyReady(), 'custom_tool', {
        label: 'Custom Tool',
        url: 'http://localhost:9001',
      });
      const plugin = getCap(s, 'custom_tool')!;
      expect(plugin).toBeDefined();
      expect(plugin.status).toBe('ready');
      expect(plugin.source).toBe('plugin');
      expect(plugin.components[0].path).toBe('http://localhost:9001');
    });

    it('preserves existing capabilities', () => {
      const base = sidecarScenarios.fullyReady();
      const s = withPlugin(base, 'ext');
      expect(s.capabilities).toEqual([...base.capabilities, getCap(s, 'ext')]);
      expect(getCap(s, 'ext')).toBeDefined();
    });
  });

  describe('composability', () => {
    it('chains modifiers', () => {
      const s = withPlugin(withMafft(sidecarScenarios.freshInstall()), 'ext_plugin');
      expect(getComp(s, 'alignment', 'mafft')?.status).toBe('ready');
      expect(getCap(s, 'ext_plugin')).toBeDefined();
      expect(getCap(s, 'annotation')?.status).toBe('unavailable');
    });
  });
});
