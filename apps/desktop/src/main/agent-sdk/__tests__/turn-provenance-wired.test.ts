import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BRIDGE_SOURCE = readFileSync(join(__dirname, '..', '..', 'agent-tools-bridge.ts'), 'utf8');
const MANAGER_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'agent-session', 'manager.ts'),
  'utf8'
);

describe('turn provenance is wired into the tool bridge', () => {
  it('the bridge imports the recorder', () => {
    expect(
      BRIDGE_SOURCE.includes('turn-workspace-provenance'),
      'agent-tools-bridge.ts no longer imports the provenance recorder, so no tool ' +
        'call is being recorded and every turn silently reads as ungrounded.'
    ).toBe(true);
  });

  it('the bridge calls the recorder with the turn id, tool name, and actual arguments', () => {
    expect(BRIDGE_SOURCE).toMatch(
      /recordCompletedToolCall\(\s*payload\.turnId\s*,\s*payload\.request\.tool_name\s*,\s*payload\.request\.args\s*\)/
    );
  });

  it('records successful staged-selection resource reads too', () => {
    expect(BRIDGE_SOURCE).toContain(
      'recordCompletedResourceRead(payload.turnId, payload.referenceId)'
    );
  });

  it('opens and closes provenance at the app-owned session lifecycle boundary', () => {
    expect(MANAGER_SOURCE).toContain('openWorkspaceProvenanceForTurn(provenanceTurnId)');
    expect(MANAGER_SOURCE).toContain('clearWorkspaceProvenanceForTurn(provenanceTurnId)');
  });

  it('records ONLY on a successful tool result', () => {
    const call = BRIDGE_SOURCE.indexOf('recordCompletedToolCall(');
    expect(call).toBeGreaterThan(-1);
    const preceding = BRIDGE_SOURCE.slice(Math.max(0, call - 800), call);
    expect(
      preceding.includes('if (response.ok)'),
      'The recorder is no longer guarded on a successful result, so failed tool ' +
        'calls would count as having consulted the workspace.'
    ).toBe(true);
  });

  it('is reached from the shared settle path, not a route-specific branch', () => {
    const start = BRIDGE_SOURCE.indexOf('finish: (response) =>');
    expect(start).toBeGreaterThan(-1);
    const end = BRIDGE_SOURCE.indexOf('\n      },', start + 1);
    const body = BRIDGE_SOURCE.slice(start, end === -1 ? undefined : end);
    expect(body).toContain('recordCompletedToolCall(');
  });
});
