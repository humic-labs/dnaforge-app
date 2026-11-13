// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  createResidueSelectionsStore,
  createSelectedCodonsStore,
} from '@waypoint/workspace-editor';
import {
  getWorkspaceResidueSelectionsStoreVersion,
  getWorkspaceResidueSelectionsStore,
  getWorkspaceSelectedCodonsStore,
  registerWorkspaceResidueSelectionsStore,
  registerWorkspaceSelectedCodonsStore,
  subscribeWorkspaceResidueSelectionsStores,
} from './selected-codon-registry';

describe('selected residue registry', () => {
  it('registers a generic residue selection store and exposes the legacy codon alias', () => {
    const store = createResidueSelectionsStore();
    const unregister = registerWorkspaceResidueSelectionsStore('/tmp/ref.gb', store);

    expect(getWorkspaceResidueSelectionsStore('/tmp/ref.gb')).toBe(store);
    expect(getWorkspaceSelectedCodonsStore('/tmp/ref.gb')).toBe(store);

    unregister();
    expect(getWorkspaceResidueSelectionsStore('/tmp/ref.gb')).toBeNull();
  });

  it('keeps the legacy selected-codons registration as an alias', () => {
    const store = createSelectedCodonsStore();
    const unregister = registerWorkspaceSelectedCodonsStore('/tmp/ref.gb', store);

    expect(getWorkspaceResidueSelectionsStore('/tmp/ref.gb')).toBe(store);
    expect(getWorkspaceSelectedCodonsStore('/tmp/ref.gb')).toBe(store);

    unregister();
    expect(getWorkspaceSelectedCodonsStore('/tmp/ref.gb')).toBeNull();
  });

  it('notifies subscribers when workspace residue stores appear and disappear', () => {
    const store = createResidueSelectionsStore();
    const versions: number[] = [];
    const unsubscribe = subscribeWorkspaceResidueSelectionsStores(() => {
      versions.push(getWorkspaceResidueSelectionsStoreVersion());
    });

    const unregister = registerWorkspaceResidueSelectionsStore('/tmp/late-ref.gb', store);
    expect(getWorkspaceResidueSelectionsStore('/tmp/late-ref.gb')).toBe(store);
    unregister();
    unsubscribe();

    expect(versions).toHaveLength(2);
    expect(versions[1]).toBeGreaterThan(versions[0]);
  });
});
