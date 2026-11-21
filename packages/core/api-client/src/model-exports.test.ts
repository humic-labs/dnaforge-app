import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AlignmentIndexResultState } from './generated/models/alignmentIndexResultState';
import { AlignmentIndexResultState as modelState } from './generated/models';
import { AlignmentIndexResultState as clientState } from './index';

describe('generated API model exports', () => {
  it('preserves enum object identity through both public entry points', () => {
    expect(modelState).toBe(AlignmentIndexResultState);
    expect(clientState).toBe(AlignmentIndexResultState);
    expect(clientState.present).toBe('present');
  });

  it('keeps interface-only models out of the runtime module graph', () => {
    const barrel = readFileSync(new URL('./generated/models/index.ts', import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(barrel, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    });
    expect(outputText).not.toContain('./operationAcceptedWorkspaceInput');
  });
});
