// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readIpcContractGroups } from '../../../../../scripts/lib/ipc-contract-groups.mjs';
import { contractEntries } from './contract';
import { ipcContracts } from './contracts';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

describe('the generators read the same contracts the app runs', () => {
  it('matches every group, mount, method, kind, channel and exposure', () => {
    const executed = ipcContracts.map((group) => ({
      group: group.name,
      mount: group.mount,
      methods: contractEntries(group).map(({ method, kind, channel, conditional }) => ({
        name: method,
        kind,
        channel,
        conditional,
      })),
    }));
    const parsed = readIpcContractGroups(repoRoot).map(({ group, mount, methods }) => ({
      group,
      mount,
      methods: methods.map(({ name, kind, channel, conditional }) => ({
        name,
        kind,
        channel,
        conditional,
      })),
    }));
    expect(parsed).toEqual(executed);
  });
});
