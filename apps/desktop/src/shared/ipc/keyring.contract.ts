import { defineGroup, invoke } from './contract';

export const keyringContract = defineGroup('keyring', {
  hasPassword: invoke<[service: string, name: string], boolean>(),
  getPassword: invoke<[service: string, name: string], string | null>(),
  setPassword: invoke<[service: string, name: string, password: string], void>(),
  deletePassword: invoke<[service: string, name: string], void>(),
});
