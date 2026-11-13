import type { IncludedAllowanceReadResult } from '@waypoint/hosted-ai-contract/included-allowance';
import { defineGroup, invoke, type ClientOf } from './contract';

export const hostedAllowanceContract = defineGroup('hostedAi', {
  readIncludedAllowance: invoke<[], IncludedAllowanceReadResult>(),
});

export type HostedAllowancePort = ClientOf<typeof hostedAllowanceContract>;
