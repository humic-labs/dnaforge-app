import type {
  SequenceMouseWheelPacket,
  SequenceWheelZoomRegion,
} from '../sequence-wheel-ownership';
import { defineGroup, event, send } from './contract';

export const sequenceWheelContract = defineGroup('sequenceWheel', {
  onMouseWheel: event<[packet: SequenceMouseWheelPacket]>().channel('sequenceWheel:mouse'),
  returnMouseWheel: send<[packet: SequenceMouseWheelPacket]>().channel('sequenceWheel:returnMouse'),
  setZoomRegions: send<[regions: SequenceWheelZoomRegion[]]>().channel(
    'sequenceWheel:setZoomRegion'
  ),
});
