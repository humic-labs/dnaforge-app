import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import {
  configurePrimerTmOutputSchema,
  getPrimerTmConfigOutputSchema,
} from './design-output-schemas';
   
                                                                              
                                                                                
                                                                 
   

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyPrimerTmModel,
  readPrimerTmConfig,
  resolveTmModelById,
  tmModelIdOf,
  configurePrimerTmSchema,
} from './configure-primer-tm';
import { useSettingsStore } from '../../junction-workbench/settings';
import { DEFAULT_TM_MODEL } from '../../design/algorithms/tm-model';
import {
  ALLOWED_RENDERER_TOOLS,
  executeRendererToolDefinition,
} from '../../agent-bridge/renderer-tools';

                                                                            
                                                                         
                                                                  
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: vi.fn().mockResolvedValue(''),
      readDir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({ size: 0, isFile: true, isDirectory: false, mtime: 0 }),
      exists: vi.fn().mockResolvedValue(false),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
    },
  }),
  initPlatform: vi.fn(),
}));

const NEB_Q5 = { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' } as const;
const NEB_PHUSION = { kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' } as const;

describe('configure_primer_tm agent tool', () => {
  beforeEach(() => {
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL });
  });

  it('applyPrimerTmModel sets the store tmModel for any catalog polymerase', () => {
    expect(applyPrimerTmModel('q5-0').model).toEqual(NEB_Q5);
    expect(useSettingsStore.getState().tmModel).toEqual(NEB_Q5);

    expect(applyPrimerTmModel('phusion-0').model).toEqual(NEB_PHUSION);
    expect(useSettingsStore.getState().tmModel).toEqual(NEB_PHUSION);
  });

  it('applyPrimerTmModel("local") restores the local default', () => {
    applyPrimerTmModel('q5-0');
    applyPrimerTmModel('local');
    expect(useSettingsStore.getState().tmModel).toEqual(DEFAULT_TM_MODEL);
  });

  it('rejects an unknown model id at the schema layer (no self-upgrade to a bogus model)', () => {
    expect(configurePrimerTmSchema.safeParse({ model: 'bogus' }).success).toBe(false);
    expect(configurePrimerTmSchema.safeParse({ model: 'q5-0' }).success).toBe(true);
    expect(configurePrimerTmSchema.safeParse({ model: 'phusion-0' }).success).toBe(true);
    expect(configurePrimerTmSchema.safeParse({ model: 'local' }).success).toBe(true);
  });

  it('round-trips model <-> id', () => {
    expect(tmModelIdOf(resolveTmModelById('phusion-0'))).toBe('phusion-0');
    expect(tmModelIdOf(DEFAULT_TM_MODEL)).toBe('local');
  });

  it('readPrimerTmConfig reports the current model', () => {
    applyPrimerTmModel('phusion-0');
    expect(readPrimerTmConfig()).toEqual({ modelId: 'phusion-0', model: NEB_PHUSION });
  });
});

                                                                               
                                                                             
                                                                         
                                                                               
describe('configure_primer_tm CLI/MCP route (Route B dispatch)', () => {
  const ctx = {
    folders: [],
    actionId: 'test-tm',
    grantedCapabilities: ['modify-settings', 'read-workspace'] as const,
  };

  beforeEach(() => {
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL });
  });

  it('configure_primer_tm handler applies the model through the renderer bridge', async () => {
    const result = await executeRendererToolDefinition(
      ALLOWED_RENDERER_TOOLS.configure_primer_tm,
      { model: 'q5-0' },
      ctx
    );
    assertMcpOutput(configurePrimerTmOutputSchema, result);
    expect(result).toMatchObject({ configured: true, modelId: 'q5-0' });
    expect(useSettingsStore.getState().tmModel).toEqual(NEB_Q5);
  });

  it('get_primer_tm_config handler reads the current model through the renderer bridge', async () => {
    applyPrimerTmModel('phusion-0');
    const result = await executeRendererToolDefinition(
      ALLOWED_RENDERER_TOOLS.get_primer_tm_config,
      {},
      ctx
    );
    assertMcpOutput(getPrimerTmConfigOutputSchema, result);
    expect(result).toEqual({ ok: true, modelId: 'phusion-0', model: NEB_PHUSION });
  });
});
