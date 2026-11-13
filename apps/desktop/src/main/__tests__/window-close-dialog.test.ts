import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mainIndex = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
const bindingSource = readFileSync(resolve(__dirname, '../quit-prompt-binding.ts'), 'utf8');
const timingSource = readFileSync(resolve(__dirname, '../quit-prompt-timing.ts'), 'utf8');
const orchestrationSource = readFileSync(resolve(__dirname, '../quit-orchestration.ts'), 'utf8');

function closeBlock(): string {
  const match = mainIndex.match(/mainWindow\.on\(['"]close['"][\s\S]*?\n  \}\);/);
  expect(match).not.toBeNull();
  return match![0];
}

describe('window close handler in main bootstrap', () => {
  it('registers a close handler on the main window', () => {
    expect(mainIndex).toMatch(/mainWindow\.on\(['"]close['"]/);
  });

  it('delegates close and quit to the prompt that returns before the dialog', () => {
    const block = closeBlock();
    expect(block).toContain('productQuit.onWindowClose');
    expect(block).not.toContain('showUnsavedWorkDialog');
    expect(block).not.toContain('.hide(');
    expect(mainIndex).toContain('productQuit.onBeforeQuit');
    expect(mainIndex).toContain('quitPromptSuppressed(app.isPackaged, process.env.WAYPOINT_TEST)');
    expect(mainIndex).toContain('getDirty: getDirtyState');
    expect(mainIndex).toContain('grantConsent: setQuitConsentGranted');
    expect(mainIndex).toContain('freezeRenderer: controls.freezeRenderer');
    expect(mainIndex).toContain('concealRenderer: controls.concealRenderer');
    expect(mainIndex).not.toMatch(/freezeRenderer:\s*\(\)\s*=>\s*\{[^}]*\.hide\(/);
  });

  it('asks while the window is visible, then hides only after the answer', () => {
    expect(bindingSource).toContain('armWindowClosePrompt');
    expect(bindingSource).toContain('armQuitOrchestration');
    expect(bindingSource).toContain('scheduleAfterCurrentEvent');
    const freeze = bindingSource.slice(
      bindingSource.indexOf('freezeRenderer()'),
      bindingSource.indexOf('restoreRenderer()')
    );
    expect(freeze).not.toContain('.hide(');
    expect(freeze).not.toContain('setEnabled');
    expect(orchestrationSource.indexOf('await showUnsavedWorkDialog')).toBeLessThan(
      orchestrationSource.indexOf('deps.concealRenderer?.()')
    );
    expect(orchestrationSource.indexOf('deps.concealRenderer?.()')).toBeLessThan(
      orchestrationSource.indexOf('await deps.killSidecar()')
    );
  });

  it('still prompts in a packaged build when WAYPOINT_TEST is set', () => {
    expect(timingSource).toMatch(/return !isPackaged && waypointTest === '1'/);
    expect(mainIndex).toContain('process.env.WAYPOINT_TEST');
  });
});
