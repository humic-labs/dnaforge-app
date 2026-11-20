import type {
  EntityDiscoveryPage,
  EntityDiscoveryRequest,
  EntityDiscoveryResolution,
  EntityDiscoveryResolveRequest,
  EntityDiscoveryTypesRequest,
  EntityDiscoveryTypes,
} from '../entity-discovery';
import { defineGroup, invoke } from './contract';

export const entityDiscoveryContract = defineGroup('entityDiscovery', {
  search: invoke<[request: EntityDiscoveryRequest], EntityDiscoveryPage>(),
  resolve: invoke<[request: EntityDiscoveryResolveRequest], EntityDiscoveryResolution>(),
  types: invoke<[request: EntityDiscoveryTypesRequest], EntityDiscoveryTypes>(),
});
