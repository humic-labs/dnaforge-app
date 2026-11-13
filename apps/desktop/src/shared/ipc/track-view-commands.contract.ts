import type { TrackViewCommand, TrackViewCommandResult } from '@waypoint/domain-services';
import { defineGroup, invoke } from './contract';

export const trackViewCommandsContract = defineGroup('trackViewCommands', {
  run: invoke<[request: TrackViewCommand], TrackViewCommandResult>(),
});
