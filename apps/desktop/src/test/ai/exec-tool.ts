export const execOpts = {
  toolCallId: 'test',
  messages: [] as never[],
  abortSignal: undefined as AbortSignal | undefined,
  grantedCapabilities: undefined as string[] | undefined,
};

export async function execTool<T>(
  tool: { execute?(args: unknown, opts: typeof execOpts): unknown },
  args: unknown,
  opts = execOpts
): Promise<T> {
  if (!tool.execute) throw new Error('Tool has no execute method');
  return (await tool.execute(args, opts)) as T;
}
