import type { McpHttpSettings, McpHttpStatus } from '../mcp-http';
import { defineGroup, invoke } from './contract';

export const agentSdkMcpHttpListenerContract = defineGroup('agentSdk', {
  getMcpHttpStatus: invoke<[], McpHttpStatus>(),
  setMcpHttp: invoke<[settings: McpHttpSettings], McpHttpStatus>(),
});
