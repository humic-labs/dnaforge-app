import rendererToolManifest from '../../../../../../packages/core/agent-tools/renderer-tool-manifest.json';

export type DirectToolName = (typeof rendererToolManifest.tools)[number]['name'];
export type InitialDirectToolStep = {
  toolChoice: 'required' | { type: 'tool'; toolName: DirectToolName };
  activeTools?: DirectToolName[];
};

export function inferInitialDirectToolStep(
  _content: string,
  _availableToolNames: readonly DirectToolName[],
  _hasWorkspace: boolean
): InitialDirectToolStep | undefined {
  return undefined;
}
