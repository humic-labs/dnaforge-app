import type { IndexedGenomeAnnotationMapperPolicy } from '../features/sequence/components/AssemblyCompiledAnnotationTrack';

export type AssemblyAnnotationIsoformMode = IndexedGenomeAnnotationMapperPolicy['isoformMode'];

export interface AssemblyAnnotationPolicyTransaction {
  committedPolicy: IndexedGenomeAnnotationMapperPolicy;
  requestedPolicy: IndexedGenomeAnnotationMapperPolicy;
  pendingRequestId: number | null;
  preparationState: 'idle' | 'preparing' | 'error';
}

type AssemblyAnnotationPolicyTestApi = {
  setAssemblyAnnotationIsoformMode?: (
    mode: AssemblyAnnotationIsoformMode
  ) => IndexedGenomeAnnotationMapperPolicy | null;
  setAssemblyAnnotationLaneLimit?: (
    laneLimit: IndexedGenomeAnnotationMapperPolicy['laneLimit']
  ) => IndexedGenomeAnnotationMapperPolicy | null;
  getAssemblyAnnotationMapperPolicy?: () => IndexedGenomeAnnotationMapperPolicy;
  getAssemblyAnnotationPolicyTransaction?: () => AssemblyAnnotationPolicyTransaction;
};

type InstalledOwner = {
  setMode: NonNullable<AssemblyAnnotationPolicyTestApi['setAssemblyAnnotationIsoformMode']>;
  setLaneLimit: NonNullable<AssemblyAnnotationPolicyTestApi['setAssemblyAnnotationLaneLimit']>;
  getPolicy: NonNullable<AssemblyAnnotationPolicyTestApi['getAssemblyAnnotationMapperPolicy']>;
  getTransaction: NonNullable<
    AssemblyAnnotationPolicyTestApi['getAssemblyAnnotationPolicyTransaction']
  >;
};

type BridgeOwnerRegistry = {
  baseSetter: AssemblyAnnotationPolicyTestApi['setAssemblyAnnotationIsoformMode'];
  baseLaneSetter: AssemblyAnnotationPolicyTestApi['setAssemblyAnnotationLaneLimit'];
  baseGetter: AssemblyAnnotationPolicyTestApi['getAssemblyAnnotationMapperPolicy'];
  baseTransactionGetter: AssemblyAnnotationPolicyTestApi['getAssemblyAnnotationPolicyTransaction'];
  owners: InstalledOwner[];
  ownedSetters: Set<AssemblyAnnotationPolicyTestApi['setAssemblyAnnotationIsoformMode']>;
  ownedLaneSetters: Set<AssemblyAnnotationPolicyTestApi['setAssemblyAnnotationLaneLimit']>;
  ownedGetters: Set<AssemblyAnnotationPolicyTestApi['getAssemblyAnnotationMapperPolicy']>;
  ownedTransactionGetters: Set<
    AssemblyAnnotationPolicyTestApi['getAssemblyAnnotationPolicyTransaction']
  >;
};

const ownerRegistries = new WeakMap<object, BridgeOwnerRegistry>();

export type AssemblyAnnotationPolicyBridgeTarget = Window & {
  __test?: AssemblyAnnotationPolicyTestApi & Record<string, unknown>;
};

export interface AssemblyAnnotationPolicyBridgeController {
  getPolicy: () => IndexedGenomeAnnotationMapperPolicy;
  getTransaction: () => AssemblyAnnotationPolicyTransaction;
  requestPolicy: (policy: IndexedGenomeAnnotationMapperPolicy) => void;
}

export function installAssemblyAnnotationPolicyTestBridge(
  target: AssemblyAnnotationPolicyBridgeTarget,
  controller: AssemblyAnnotationPolicyBridgeController
): () => void {
  const testApi = target.__test;
  if (!testApi) {
    throw new Error('assembly annotation policy test bridge requires window.__test');
  }

  let registry = ownerRegistries.get(testApi);
  if (!registry) {
    registry = {
      baseSetter: testApi.setAssemblyAnnotationIsoformMode,
      baseLaneSetter: testApi.setAssemblyAnnotationLaneLimit,
      baseGetter: testApi.getAssemblyAnnotationMapperPolicy,
      baseTransactionGetter: testApi.getAssemblyAnnotationPolicyTransaction,
      owners: [],
      ownedSetters: new Set(),
      ownedLaneSetters: new Set(),
      ownedGetters: new Set(),
      ownedTransactionGetters: new Set(),
    };
    ownerRegistries.set(testApi, registry);
  }
  const setAssemblyAnnotationIsoformMode = (
    mode: AssemblyAnnotationIsoformMode
  ): IndexedGenomeAnnotationMapperPolicy | null => {
    if (mode !== 'canonical' && mode !== 'expanded') return null;
    const next = { ...controller.getPolicy(), isoformMode: mode };
    controller.requestPolicy(next);
    return next;
  };
  const setAssemblyAnnotationLaneLimit = (
    laneLimit: IndexedGenomeAnnotationMapperPolicy['laneLimit']
  ): IndexedGenomeAnnotationMapperPolicy | null => {
    if (laneLimit !== null && (!Number.isSafeInteger(laneLimit) || laneLimit <= 0)) {
      return null;
    }
    const next = { ...controller.getPolicy(), laneLimit };
    controller.requestPolicy(next);
    return next;
  };
  const getAssemblyAnnotationMapperPolicy = () => ({ ...controller.getPolicy() });
  const getAssemblyAnnotationPolicyTransaction = () => {
    const transaction = controller.getTransaction();
    return {
      ...transaction,
      committedPolicy: { ...transaction.committedPolicy },
      requestedPolicy: { ...transaction.requestedPolicy },
    };
  };

  const owner: InstalledOwner = {
    setMode: setAssemblyAnnotationIsoformMode,
    setLaneLimit: setAssemblyAnnotationLaneLimit,
    getPolicy: getAssemblyAnnotationMapperPolicy,
    getTransaction: getAssemblyAnnotationPolicyTransaction,
  };
  registry.owners.push(owner);
  registry.ownedSetters.add(setAssemblyAnnotationIsoformMode);
  registry.ownedLaneSetters.add(setAssemblyAnnotationLaneLimit);
  registry.ownedGetters.add(getAssemblyAnnotationMapperPolicy);
  registry.ownedTransactionGetters.add(getAssemblyAnnotationPolicyTransaction);

  testApi.setAssemblyAnnotationIsoformMode = setAssemblyAnnotationIsoformMode;
  testApi.setAssemblyAnnotationLaneLimit = setAssemblyAnnotationLaneLimit;
  testApi.getAssemblyAnnotationMapperPolicy = getAssemblyAnnotationMapperPolicy;
  testApi.getAssemblyAnnotationPolicyTransaction = getAssemblyAnnotationPolicyTransaction;

  return () => {
    const ownerIndex = registry.owners.indexOf(owner);
    if (ownerIndex < 0) return;
    registry.owners.splice(ownerIndex, 1);
    const currentPairIsOurs =
      registry.ownedSetters.has(testApi.setAssemblyAnnotationIsoformMode) &&
      registry.ownedLaneSetters.has(testApi.setAssemblyAnnotationLaneLimit) &&
      registry.ownedGetters.has(testApi.getAssemblyAnnotationMapperPolicy) &&
      registry.ownedTransactionGetters.has(testApi.getAssemblyAnnotationPolicyTransaction);
    if (currentPairIsOurs) {
      const active = registry.owners[registry.owners.length - 1];
      if (active) {
        testApi.setAssemblyAnnotationIsoformMode = active.setMode;
        testApi.setAssemblyAnnotationLaneLimit = active.setLaneLimit;
        testApi.getAssemblyAnnotationMapperPolicy = active.getPolicy;
        testApi.getAssemblyAnnotationPolicyTransaction = active.getTransaction;
      } else {
        if (registry.baseSetter) {
          testApi.setAssemblyAnnotationIsoformMode = registry.baseSetter;
        } else {
          delete testApi.setAssemblyAnnotationIsoformMode;
        }
        if (registry.baseGetter) {
          testApi.getAssemblyAnnotationMapperPolicy = registry.baseGetter;
        } else {
          delete testApi.getAssemblyAnnotationMapperPolicy;
        }
        if (registry.baseLaneSetter) {
          testApi.setAssemblyAnnotationLaneLimit = registry.baseLaneSetter;
        } else {
          delete testApi.setAssemblyAnnotationLaneLimit;
        }
        if (registry.baseTransactionGetter) {
          testApi.getAssemblyAnnotationPolicyTransaction = registry.baseTransactionGetter;
        } else {
          delete testApi.getAssemblyAnnotationPolicyTransaction;
        }
      }
    }
    if (registry.owners.length === 0) ownerRegistries.delete(testApi);
  };
}
