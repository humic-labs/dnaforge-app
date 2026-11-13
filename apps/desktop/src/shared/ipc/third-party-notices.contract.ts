import { defineGroup, invoke, type ClientOf } from './contract';

export type ThirdPartyNotices =
  | { readonly status: 'available'; readonly text: string }
  | { readonly status: 'unavailable' };

export const thirdPartyNoticesContract = defineGroup('thirdPartyNotices', {
  read: invoke<[], ThirdPartyNotices>(),
  openChromiumLicenses: invoke<[], boolean>(),
});

export type ThirdPartyNoticesPort = ClientOf<typeof thirdPartyNoticesContract>;
