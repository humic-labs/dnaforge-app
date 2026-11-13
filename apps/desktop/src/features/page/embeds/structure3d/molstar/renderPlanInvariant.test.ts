import { describe, expect, it } from 'vitest';
import type { StructureRenderTransaction } from '../utils/structureRenderTransaction';
import { viewerCache, type StructureRepresentationDiagnostic } from './cache';
import {
  assertStructureRenderPlanSatisfiedForViewer,
  findStructureRenderPlanViolation,
} from './renderPlanInvariant';
import { STRUCTURE_CONTEXT_MOLSTAR_COLOR } from '../utils/structureRenderModel';

describe('render plan invariants', () => {
  it('fails complex plans that leak a visible broad chain-colored polymer before scoped context styling', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          { chainInstanceId: 'g-g-25-asm_1-g', detailVisible: true },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Polymer', 'cartoon'),
        hiddenComponent('Structure Context', 'cartoon'),
        hiddenComponent('Query Polymer', 'cartoon'),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'unexpected-visible-unscoped-polymer',
        visibleUnscopedPolymerCount: 1,
        expectedVisiblePolymerRoles: ['context', 'query'],
      })
    );
  });

  it('fails loaded polymer plans that silently render only ligands or ions', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction([
        { role: 'context', visible: true },
        { role: 'query', visible: true },
        { role: 'ligand', visible: true },
        { role: 'ion', visible: true },
      ]),
      diagnostic: fakeDiagnostic([
        hiddenComponent('Structure Context', 'cartoon'),
        hiddenComponent('Query Polymer', 'cartoon'),
        visibleComponent('Ligand', 'ball-and-stick'),
        visibleComponent('Ion', 'spacefill'),
      ]),
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'missing-visible-polymer',
        visiblePolymerCount: 0,
        visibleNonPolymerCount: 2,
        expectedVisiblePolymerRoles: ['context', 'query'],
      })
    );
  });

  it('allows gray context plus selected query polymer render plans', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction([
        { role: 'context', visible: true },
        { role: 'query', visible: true },
        { role: 'ligand', visible: true },
      ]),
      diagnostic: fakeDiagnostic([
        visibleComponent('Structure Context', 'cartoon'),
        visibleComponent('Query Polymer', 'cartoon'),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toBeNull();
  });

  it('allows monomer/default and monomer recipe plans to use a broad polymer component', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
        ],
        [{ chainInstanceId: 'a-a-1-1_555-a', detailVisible: true }],
        { activeRecipeId: 'illustrative' }
      ),
      diagnostic: fakeDiagnostic([visibleComponent('Polymer', 'spacefill')]),
    });

    expect(violation).toBeNull();
  });

  it('allows a local multi-chain structure with no scoped detail targets to use its broad polymer component', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'unscoped', visible: true },
        ],
        [
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: true },
          { chainInstanceId: 'b-b-2-asm_1-b', detailVisible: true },
        ],
        { activeRecipeId: 'cartoon', renderIntent: 'loaded' }
      ),
      diagnostic: fakeDiagnostic([visibleComponent('Polymer', 'cartoon')]),
      expectsDetailChainComponents: false,
    });

    expect(violation).toBeNull();
  });

  it('fails resolved chain-detail plans where context rows have no visible context polymer', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          { chainInstanceId: 'g-g-25-asm_1-g', detailVisible: true },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon'),
        hiddenComponent('Structure Detail Context', 'cartoon'),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'missing-visible-context-polymer',
        visiblePolymerCount: 1,
        visibleContextPolymerCount: 0,
        visibleNonPolymerCount: 1,
        contextRowCount: 1,
      })
    );
  });

  it('fails Surface Context plans when the selected cartoon exists but the context surface is missing', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true, kind: 'surface' },
          { role: 'query', visible: true, kind: 'cartoon' },
          { role: 'ligand', visible: true, kind: 'ball-and-stick' },
        ],
        [
          { chainInstanceId: 'g-g-25-asm_1-g', detailVisible: true },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon'),
        hiddenComponent('Structure Detail Context', 'cartoon'),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'missing-visible-surface-layer',
        expectedVisibleSurfacePolymerRoles: ['context'],
        visibleContextSurfacePolymerCount: 0,
        visibleContextNonSurfacePolymerCount: 0,
        contextRowCount: 1,
      })
    );
  });

  it('allows Surface Context to hide context cartoons only when the context surface is visible', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true, kind: 'surface' },
          { role: 'query', visible: true, kind: 'cartoon' },
          { role: 'ligand', visible: true, kind: 'ball-and-stick' },
        ],
        [
          { chainInstanceId: 'g-g-25-asm_1-g', detailVisible: true },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon'),
        component('Structure Detail Context', [
          representation('cartoon', 0),
          representation('molecular-surface', 0.13, ['surface-overlay'], {
            colorThemeName: 'chain-id',
            colorThemeParams: grayChainPaletteParams(),
          }),
        ]),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toBeNull();
  });

  it('allows broad Surface Context surfaces to contain selected detail chains', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true, kind: 'surface' },
          { role: 'query', visible: true, kind: 'cartoon' },
          { role: 'ligand', visible: true, kind: 'ball-and-stick' },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            displayChainId: 'G',
            labelAsymId: 'G',
            authAsymId: 'G',
            entityId: '25',
            operator: 'ASM_1',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          {
            chainInstanceId: 'a-a-1-asm_1-a',
            displayChainId: 'A',
            labelAsymId: 'A',
            authAsymId: 'A',
            entityId: '1',
            operator: 'ASM_1',
            detailVisible: false,
          },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
          chains: [chainDiagnostic({ authAsymId: 'G', labelAsymId: 'G', entityId: '25' })],
        }),
        component(
          'Structure Context',
          [
            representation('cartoon', 0, [], {
              colorThemeName: 'chain-id',
              colorThemeParams: grayChainPaletteParams(),
            }),
            representation('molecular-surface', 0.13, ['surface-overlay'], {
              colorThemeName: 'chain-id',
              colorThemeParams: grayChainPaletteParams(),
            }),
          ],
          {
            chains: [
              chainDiagnostic({
                authAsymId: 'G',
                labelAsymId: 'G',
                entityId: '25',
                operatorName: 'ASM_1',
              }),
              chainDiagnostic({
                authAsymId: 'A',
                labelAsymId: 'A',
                entityId: '1',
                operatorName: 'ASM_1',
              }),
            ],
          }
        ),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('allows gray detail context that contains only context rows', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          { chainInstanceId: 'g-g-25-asm_1-g', detailVisible: true },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon'),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
          chains: [chainDiagnostic({ authAsymId: 'A', labelAsymId: 'A', entityId: '1' })],
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toBeNull();
  });

  it('fails resolved chain-detail plans when a selected chain is still in gray context', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            displayChainId: 'G',
            labelAsymId: 'G',
            authAsymId: 'G',
            entityId: '25',
            operator: 'ASM_1',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          {
            chainInstanceId: 'a-a-1-asm_1-a',
            displayChainId: 'A',
            labelAsymId: 'A',
            authAsymId: 'A',
            entityId: '1',
            operator: 'ASM_1',
            detailVisible: false,
          },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
          chains: [chainDiagnostic({ authAsymId: 'G', labelAsymId: 'G', entityId: '25' })],
        }),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
          chains: [
            chainDiagnostic({
              authAsymId: 'G',
              labelAsymId: 'G',
              entityId: '25',
              operatorName: 'ASM_1',
            }),
            chainDiagnostic({ authAsymId: 'A', labelAsymId: 'A', entityId: '1' }),
          ],
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'selected-chain-leaked-into-context',
        contextChainLeaks: [
          expect.objectContaining({
            chainInstanceId: 'g-g-25-asm_1-g',
            displayChainId: 'G',
            label: 'Structure Detail Context',
          }),
        ],
      })
    );
  });

  it('does not cross-match swapped auth and label asym ids when checking selected-chain context leaks', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'c-b-2-asm_1-b',
            displayChainId: 'C',
            labelAsymId: 'B',
            authAsymId: 'C',
            entityId: '2',
            operator: 'ASM_1',
            detailVisible: true,
            displayMolstarColor: 0x2ca02c,
          },
          {
            chainInstanceId: 'b-c-2-asm_1-c',
            displayChainId: 'B',
            labelAsymId: 'C',
            authAsymId: 'B',
            entityId: '2',
            operator: 'ASM_1',
            detailVisible: false,
          },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: c-b-2-asm_1-b', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x2ca02c },
          chains: [
            chainDiagnostic({
              authAsymId: 'C',
              labelAsymId: 'B',
              entityId: '2',
              operatorName: 'ASM_1',
            }),
          ],
        }),
        hiddenComponent('Detail Context Chain: c-b-2-asm_1-b', 'cartoon'),
        visibleComponent('Detail Context Chain: b-c-2-asm_1-c', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
          chains: [
            chainDiagnostic({
              authAsymId: 'B',
              labelAsymId: 'C',
              entityId: '2',
              operatorName: 'ASM_1',
            }),
          ],
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('does not treat case-distinct auth asym ids as the same chain for context leaks', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'z-a-1-asm_1-a',
            displayChainId: 'Z',
            labelAsymId: 'A',
            authAsymId: 'Z',
            entityId: '1',
            operator: 'ASM_1',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          {
            chainInstanceId: 'z-ab-1-asm_1-z',
            displayChainId: 'z',
            labelAsymId: 'AB',
            authAsymId: 'z',
            entityId: '1',
            operator: 'ASM_1',
            detailVisible: false,
          },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: z-a-1-asm_1-a', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
          chains: [
            chainDiagnostic({
              authAsymId: 'Z',
              labelAsymId: 'A',
              entityId: '1',
              operatorName: 'ASM_1',
            }),
          ],
        }),
        visibleComponent('Structure Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
          chains: [
            chainDiagnostic({
              authAsymId: 'z',
              labelAsymId: 'AB',
              entityId: '1',
              operatorName: 'ASM_1',
            }),
          ],
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('does not report selected-chain context leaks when the transaction has no context rows', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'a-a-1-asm_1-a',
            displayChainId: 'A',
            labelAsymId: 'A',
            authAsymId: 'A',
            entityId: '1',
            operator: 'ASM_1',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          {
            chainInstanceId: 'b-b-1-asm_1-b',
            displayChainId: 'B',
            labelAsymId: 'B',
            authAsymId: 'B',
            entityId: '1',
            operator: 'ASM_1',
            detailVisible: true,
            displayMolstarColor: 0xff7f0e,
          },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: a-a-1-asm_1-a', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
          chains: [chainDiagnostic({ authAsymId: 'A', labelAsymId: 'A', entityId: '1' })],
        }),
        visibleComponent('Detail Chain: b-b-1-asm_1-b', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0xff7f0e },
          chains: [chainDiagnostic({ authAsymId: 'B', labelAsymId: 'B', entityId: '1' })],
        }),
        visibleComponent('Structure Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
          chains: [
            chainDiagnostic({ authAsymId: 'A', labelAsymId: 'A', entityId: '1' }),
            chainDiagnostic({ authAsymId: 'B', labelAsymId: 'B', entityId: '1' }),
          ],
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('fails resolved chain-detail plans when a visible detail chain is hidden in MolStar', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        hiddenComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon'),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'visible-detail-chain-mismatch',
        mismatchedDetailChains: [
          expect.objectContaining({
            chainInstanceId: 'g-g-25-asm_1-g',
            expectedMolstarColor: 0x1f77b4,
            actualVisible: false,
          }),
        ],
      })
    );
  });

  it('fails resolved chain-detail plans when a visible detail chain has the wrong MolStar color', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0xff0000 },
        }),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'visible-detail-chain-mismatch',
        mismatchedDetailChains: [
          expect.objectContaining({
            chainInstanceId: 'g-g-25-asm_1-g',
            expectedMolstarColor: 0x1f77b4,
            actualMolstarColor: 0xff0000,
          }),
        ],
      })
    );
  });

  it('allows resolved detail-chain plans to use B-factor color themes when the transaction requests B-factor', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true, colorMode: 'bfactor' },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'uncertainty',
          colorThemeParams: { domain: [0, 100] },
        }),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('uses MolStar render plan defaults for detail-chain color mode when the transaction has no query role', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ],
        { activeRecipeId: null }
      ),
      molstarPlan: {
        defaults: { representation: 'cartoon', colorMode: 'element' },
        rolePlan: { polymerOverrides: {}, visibility: {} },
      },
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'element-symbol',
          colorThemeParams: { carbonColor: { name: 'chain-id', params: {} } },
        }),
        hiddenComponent('Detail Context Chain: g-g-25-asm_1-g', 'cartoon'),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('fails resolved B-factor detail-chain plans when MolStar stays on uniform row colors', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true, colorMode: 'bfactor' },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
        }),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'visible-detail-chain-mismatch',
        mismatchedDetailChains: [
          expect.objectContaining({
            chainInstanceId: 'g-g-25-asm_1-g',
            expectedColorMode: 'bfactor',
            actualColorThemeName: 'uniform',
          }),
        ],
      })
    );
  });

  it('fails resolved chain-detail plans when context rows are not gray in MolStar', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-25-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x1f77b4,
          },
          { chainInstanceId: 'a-a-1-asm_1-a', detailVisible: false },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-25-asm_1-g', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
        }),
        visibleComponent('Structure Detail Context', 'cartoon', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x1f77b4 },
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toEqual(
      expect.objectContaining({
        code: 'visible-context-chain-color-mismatch',
        mismatchedContextComponents: [
          expect.objectContaining({
            label: 'Structure Detail Context',
            actualColorThemeName: 'uniform',
            actualMolstarColor: 0x1f77b4,
          }),
        ],
      })
    );
  });

  it('does not require detail-chain components for preview-scoped query/context renders', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
          { role: 'ligand', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-2-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x2ca02c,
          },
          {
            chainInstanceId: 'e-e-1-asm_1-e',
            detailVisible: false,
            displayMolstarColor: STRUCTURE_CONTEXT_MOLSTAR_COLOR,
          },
        ],
        { activeRecipeId: 'query-in-complex-preview', renderIntent: 'preview' }
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Structure Context', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: grayChainPaletteParams(),
        }),
        visibleComponent('Query Polymer', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: { palette: { params: { list: { colors: [0x2ca02c] } } } },
        }),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
    });

    expect(violation).toBeNull();
  });

  it('does not require detail-chain components for a single-chain broad polymer render', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [{ role: 'unscoped', visible: true }],
        [
          {
            chainInstanceId: 'a-a-1-1_555-a',
            detailVisible: true,
            displayMolstarColor: 0xe6194b,
          },
        ],
        { activeRecipeId: null }
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Polymer', 'cartoon', {
          colorThemeName: 'chain-id',
          colorThemeParams: { palette: { params: { list: { colors: [0xe6194b] } } } },
        }),
      ]),
    });

    expect(violation).toBeNull();
  });

  it('accepts MolStar illustrative context when its nested style palette is gray', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction(
        [
          { role: 'context', visible: true },
          { role: 'query', visible: true },
        ],
        [
          {
            chainInstanceId: 'g-g-2-asm_1-g',
            detailVisible: true,
            displayMolstarColor: 0x2ca02c,
          },
          {
            chainInstanceId: 'e-e-1-asm_1-e',
            detailVisible: false,
            displayMolstarColor: STRUCTURE_CONTEXT_MOLSTAR_COLOR,
          },
        ]
      ),
      diagnostic: fakeDiagnostic([
        visibleComponent('Detail Chain: g-g-2-asm_1-g', 'spacefill', {
          colorThemeName: 'uniform',
          colorThemeParams: { value: 0x2ca02c },
        }),
        visibleComponent('Structure Detail Context', 'spacefill', {
          colorThemeName: 'illustrative',
          colorThemeParams: {
            style: {
              name: 'chain-id',
              params: grayChainPaletteParams(),
            },
          },
        }),
      ]),
      expectsDetailChainComponents: true,
    });

    expect(violation).toBeNull();
  });

  it('does not fail intentional non-polymer-only plans', () => {
    const violation = findStructureRenderPlanViolation({
      transaction: fakeTransaction([{ role: 'ligand', visible: true }]),
      diagnostic: fakeDiagnostic([visibleComponent('Ligand', 'ball-and-stick')]),
    });

    expect(violation).toBeNull();
  });

  it('fails before reveal even while the cache entry is still marked loading', () => {
    const viewerCacheKey = 'viewer:before-reveal';
    viewerCache.set(viewerCacheKey, {
      container: document.createElement('div'),
      plugin: fakePlugin([
        hiddenComponent('Structure Context', 'cartoon'),
        hiddenComponent('Query Polymer', 'cartoon'),
        visibleComponent('Ligand', 'ball-and-stick'),
      ]),
      isLoading: true,
      error: null,
      lastUsed: Date.now(),
    });

    try {
      expect(() =>
        assertStructureRenderPlanSatisfiedForViewer({
          viewerCacheKey,
          transaction: fakeTransaction([
            { role: 'context', visible: true },
            { role: 'query', visible: true },
            { role: 'ligand', visible: true },
          ]),
          phase: 'before-reveal',
        })
      ).toThrow(/zero visible polymer/);
    } finally {
      viewerCache.delete(viewerCacheKey);
    }
  });
});

function fakeTransaction(
  representations: Array<{ role: string; visible: boolean; kind?: string; colorMode?: string }>,
  rows: Array<{
    chainInstanceId: string;
    displayChainId?: string;
    labelAsymId?: string;
    authAsymId?: string;
    entityId?: string;
    operator?: string;
    detailVisible: boolean;
    displayMolstarColor?: number;
  }> = [],
  options: {
    activeRecipeId?: string | null;
    renderIntent?: StructureRenderTransaction['renderIntent'];
  } = {}
): StructureRenderTransaction {
  return {
    schemaVersion: 1,
    renderIntent: options.renderIntent ?? 'loaded',
    sceneId: 'scene:test',
    activeRecipeId:
      options.activeRecipeId === undefined ? 'query-in-complex' : options.activeRecipeId,
    chainCatalogStatus: 'resolved',
    planHash: 'wprtx_test',
    layers: [],
    table: {
      sourcePaletteId: 'test',
      rows: rows.map((row) => ({
        chainInstanceId: row.chainInstanceId as never,
        displayChainId: row.displayChainId ?? row.chainInstanceId.slice(0, 1).toUpperCase(),
        ...(row.labelAsymId ? { labelAsymId: row.labelAsymId } : {}),
        ...(row.authAsymId ? { authAsymId: row.authAsymId } : {}),
        ...(row.entityId ? { entityId: row.entityId } : {}),
        ...(row.operator ? { operator: row.operator } : {}),
        groupId: `group:${row.chainInstanceId}` as never,
        groupLabel: row.chainInstanceId,
        detailVisible: row.detailVisible,
        ...(row.displayMolstarColor !== undefined
          ? { displayMolstarColor: row.displayMolstarColor }
          : {}),
      })),
      chainColors: Object.fromEntries(
        rows.map((row) => [row.chainInstanceId, row.displayMolstarColor ?? null])
      ),
    },
    molstar: {
      sourcePaletteId: 'test',
      chainColors: {},
      representations: representations.map((representation, index) => ({
        layerId: `layer-${index}`,
        role: representation.role as never,
        kind: (representation.kind ?? 'cartoon') as never,
        componentTag: `component-${index}` as never,
        representationTag: `representation-${index}` as never,
        visible: representation.visible,
        colorMode: (representation.colorMode ?? 'chain') as never,
      })),
    },
    canvas: { outlineEnabled: false, aoEnabled: false },
    invariants: { previewAllowsSurface: false, hasSurfaceLayer: false, surfaceLayerKeys: [] },
  };
}

function fakeDiagnostic(
  components: StructureRepresentationDiagnostic['components']
): StructureRepresentationDiagnostic {
  return {
    key: 'viewer:test',
    isLoading: false,
    error: null,
    hasPlugin: true,
    isConnected: true,
    structureCount: 1,
    representationCount: components.reduce(
      (sum, component) => sum + component.representations.length,
      0
    ),
    componentLabels: components.map((component) => component.label).filter(Boolean) as string[],
    components,
  };
}

function visibleComponent(
  label: string,
  typeName: string,
  options?: ComponentOptions
): StructureRepresentationDiagnostic['components'][number] {
  return component(label, [representation(typeName, 1, [], options)], {
    chains: options?.chains,
  });
}

function hiddenComponent(
  label: string,
  typeName: string
): StructureRepresentationDiagnostic['components'][number] {
  return component(label, [representation(typeName, 0)]);
}

function component(
  label: string,
  representations: StructureRepresentationDiagnostic['components'][number]['representations'],
  options: { chains?: StructureRepresentationDiagnostic['components'][number]['chains'] } = {}
): StructureRepresentationDiagnostic['components'][number] {
  return {
    label,
    ref: `${label}-component`,
    elementCount: 1,
    chains: options.chains ?? [],
    representations,
  };
}

function representation(
  typeName: string,
  alpha: number,
  tags: string[] = [],
  options: RepresentationOptions = {}
): StructureRepresentationDiagnostic['components'][number]['representations'][number] {
  return {
    ref: `${typeName}-${tags.join('-') || 'representation'}-${alpha}`,
    tags,
    typeName,
    typeParams: { alpha },
    colorThemeName: options.colorThemeName ?? 'chain-id',
    colorThemeParams: options.colorThemeParams ?? {},
    sizeThemeName: 'uniform',
    sizeThemeParams: {},
    alpha,
  };
}

type RepresentationOptions = {
  colorThemeName?: string;
  colorThemeParams?: Record<string, unknown>;
};

type ComponentOptions = RepresentationOptions & {
  chains?: StructureRepresentationDiagnostic['components'][number]['chains'];
};

function chainDiagnostic(input: {
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operatorName?: string;
}): StructureRepresentationDiagnostic['components'][number]['chains'][number] {
  return {
    labelAsymId: input.labelAsymId ?? null,
    authAsymId: input.authAsymId ?? null,
    entityId: input.entityId ?? null,
    entityType: 'polymer',
    entitySubtype: null,
    operatorName: input.operatorName ?? 'ASM_1',
    unitKind: null,
    elementCount: 1,
  };
}

function grayChainPaletteParams(): Record<string, unknown> {
  return {
    palette: {
      params: {
        list: {
          colors: [STRUCTURE_CONTEXT_MOLSTAR_COLOR],
        },
      },
    },
  };
}

function fakePlugin(components: StructureRepresentationDiagnostic['components']): never {
  return {
    managers: {
      structure: {
        hierarchy: {
          current: {
            structures: [
              {
                cell: { obj: { data: { models: [] } } },
                components: components.map((component) => ({
                  cell: {
                    obj: { label: component.label },
                    transform: { ref: component.ref },
                  },
                  representations: component.representations.map((representation) => ({
                    cell: {
                      transform: { ref: representation.ref, tags: representation.tags },
                      params: {
                        values: {
                          type: {
                            name: representation.typeName,
                            params: representation.typeParams,
                          },
                          colorTheme: {
                            name: representation.colorThemeName,
                            params: representation.colorThemeParams,
                          },
                          sizeTheme: {
                            name: representation.sizeThemeName,
                            params: representation.sizeThemeParams,
                          },
                        },
                      },
                    },
                  })),
                })),
              },
            ],
          },
        },
      },
    },
  } as never;
}
