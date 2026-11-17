import type { ContactSourceReadRequest, ContactSourceReadResult } from '../contact-source';
import { defineGroup, invoke } from './contract';

export const contactSourcesContract = defineGroup('contactSources', {
  read: invoke<[request: ContactSourceReadRequest], ContactSourceReadResult>(),
});
