import type { EntityNavigationScheme, EntityNavigationTarget } from '../entity-navigation';
import { defineGroup, event, invoke } from './contract';

export const entityNavigationContract = defineGroup('entityNavigation', {
  getScheme: invoke<[], EntityNavigationScheme>(),
  takePending: invoke<[], EntityNavigationTarget[]>(),
  onOpen: event<[targets: EntityNavigationTarget[]]>().channel('entity-navigation:open'),
});
