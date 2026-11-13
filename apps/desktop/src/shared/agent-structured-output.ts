export type AgentStructuredOutputStatus = 'valid' | 'invalid';

export interface AgentStructuredOutputReceipt {
  turnId: string;
  schema: Record<string, unknown>;
  rawResult: string;
  status: AgentStructuredOutputStatus;
  parsed: unknown | null;
  validationError: string | null;
  artifactId: string;
  createdAt: number;
}

export const AGENT_GENERIC_OBJECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
};
