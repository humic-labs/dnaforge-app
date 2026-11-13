import type { NativeWheelMetadata } from '../sequence-wheel-ownership';
import { defineGroup, event } from './contract';

export const sequenceWheelContract = defineGroup('sequenceWheel', {
  onWheelMetadata: event<[packet: NativeWheelMetadata]>().channel('sequenceWheel:metadata'),
});
