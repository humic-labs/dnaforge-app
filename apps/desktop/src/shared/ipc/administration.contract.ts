import { defineGroup, event, invoke } from './contract';
import type {
  AdministrationEvent,
  AdministrationRequest,
  AdministrationResult,
} from '../administration';

export const administrationContract = defineGroup('administration', {
  execute: invoke<[request: AdministrationRequest], AdministrationResult>(),
  onChanged: event<[event: AdministrationEvent]>().channel('administration:changed'),
});
