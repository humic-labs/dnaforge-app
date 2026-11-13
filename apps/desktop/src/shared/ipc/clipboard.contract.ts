import { defineGroup, invoke } from './contract';

export const clipboardContract = defineGroup('clipboard', {
  writeText: invoke<[text: string], void>(),
});
