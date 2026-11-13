import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasRequiredCapabilities } from './capability-policy';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const api = path.join(repoRoot, 'apps/api');
const ownedPython = path.join(
  api,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const python = existsSync(ownedPython)
  ? ownedPython
  : process.platform === 'win32'
    ? 'python'
    : 'python3';
const cases = [
  { provided: [], required: [], allowed: true },
  { provided: [], required: ['read-workspace'], allowed: false },
  { provided: ['write-workspace'], required: ['edit-primers', 'edit-protocols'], allowed: true },
  { provided: ['write-workspace'], required: ['read-workspace'], allowed: false },
  { provided: ['edit-primers'], required: ['write-workspace'], allowed: false },
  { provided: ['edit-protocols'], required: ['write-workspace'], allowed: false },
  { provided: ['write-workspace'], required: ['finalize-protocol'], allowed: false },
  { provided: ['edit-protocols'], required: ['finalize-protocol'], allowed: false },
  { provided: ['read-workspace'], required: ['edit-primers'], allowed: false },
  { provided: ['*'], required: ['edit-primers', 'finalize-protocol'], allowed: true },
  { provided: ['constructor'], required: ['edit-primers'], allowed: false },
  { provided: ['toString'], required: ['edit-protocols'], allowed: false },
  { provided: ['__proto__'], required: ['write-workspace'], allowed: false },
];

describe('shared permission decisions', () => {
  it('makes TypeScript actions and the Python sidecar agree on the actual shared policy', () => {
    const sidecar = JSON.parse(
      execFileSync(
        python,
        [
          '-c',
          'import json,sys; from src.capability_policy import has_required_capabilities; print(json.dumps([has_required_capabilities(c["provided"],c["required"]) for c in json.load(sys.stdin)]))',
        ],
        {
          cwd: api,
          env: {
            ...process.env,
            DNAFORGE_AGENT_TOOLS_DIR: path.join(repoRoot, 'packages/core/agent-tools'),
          },
          input: JSON.stringify(cases),
          encoding: 'utf8',
        }
      )
    );
    const expected = cases.map((entry) => entry.allowed);
    expect(
      cases.map(({ provided, required }) => hasRequiredCapabilities(provided, required))
    ).toEqual(expected);
    expect(sidecar).toEqual(expected);
  });
});
