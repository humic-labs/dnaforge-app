   
                                                                         
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useCanvasStore } from '../../canvas/public/store';
import { useDesignStore } from '../../design/public/store';
import type { AssemblyMethod } from '../../design/public/types';
import { canonicalGoldenGateEnzymeName } from '@waypoint/sequence-utils';
import { createDesignMutationClaim } from './agent-mutation';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { ensureDesignArtifact } from '../../design/public/materialize-design-artifact';
import {
  resolveExplicitProjectRoot,
  soleWritableProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';

export const createDesignSchema = z
  .object({
    name: z.string().min(1).max(200).describe('Display name for the new design'),
    assemblyMethod: z
      .enum(['gibson', 'nebuilder', 'goldengate'])
      .optional()
      .describe('Assembly method to initialize the design with. Defaults to Gibson.'),
    goldenGateEnzyme: z
      .enum(['BsaI', 'BbsI', 'BpiI', 'BsmBI', 'Esp3I', 'SapI'])
      .optional()
      .describe(
        'Type IIS enzyme for a Golden Gate design. Ignored for other assembly methods. ' +
          'Defaults to BsaI. BpiI is an isoschizomer of BbsI and Esp3I of BsmBI; both are ' +
          'stored under the canonical name.'
      ),
    destinationProject: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Mounted writable project name for the durable design. Required when more than one writable project is open.'
      ),
    open: z
      .boolean()
      .optional()
      .describe(
        'Whether to open the new design in the canvas. Defaults to false; use true only when the user asks to view it immediately.'
      ),
  })
  .strict();

export function createCreateDesignTool(folders: readonly WorkspaceFolder[]) {
  return resultTool({
    description:
      'Create a durable assembly/design document in a writable DNAForge project. ' +
      'Use this before composing derivative plasmids or drafting assembly plans. ' +
      'When multiple writable projects are open, name destinationProject explicitly.',
    inputSchema: createDesignSchema as z.ZodTypeAny,
    execute: async (
      {
        name,
        assemblyMethod,
        goldenGateEnzyme,
        destinationProject,
        open,
      }: z.infer<typeof createDesignSchema>,
      context?: { toolCallId?: string }
    ) =>
      runDesignTool('CREATE_DESIGN_FAILED', async (effects) => {
        const writableProjects = writableProjectRoots(folders);
        const selectedProject = destinationProject
          ? resolveExplicitProjectRoot(writableProjects, destinationProject)
          : soleWritableProjectRoot(writableProjects);
        if (folders.length > 0 && !selectedProject) {
          return designToolFailure(
            'CREATE_DESIGN_FAILED',
            {
              created: false,
              code: destinationProject ? 'PROJECT_NOT_FOUND' : 'PROJECT_REQUIRED',
              error: destinationProject
                ? `No uniquely named writable project matches "${destinationProject}".`
                : writableProjects.length === 0
                  ? 'No writable project is open.'
                  : 'More than one writable project is open. Set destinationProject to the exact project name.',
            },
            effects
          );
        }
        const method = (assemblyMethod ?? 'gibson') as AssemblyMethod;
        effects.attemptedMutation();
        const designId = useDesignStore.getState().createDesign(name, 'circular', method);

                                                                                    
                                                                                
                                                                                  
                                                                                
                                                                              
                                                                      
        if (method === 'goldengate' && goldenGateEnzyme) {
          const canonical = canonicalGoldenGateEnzymeName(goldenGateEnzyme);
          if (canonical) {
            useDesignStore.getState().setAssemblyMethod(designId, method, canonical);
          }
        }

        const design = useDesignStore.getState().designs[designId];
        const workspaceRoot = selectedProject?.path ?? null;
        if (design && workspaceRoot) {
          try {
            await ensureDesignArtifact({
              design,
              workspaceRoot,
              source: 'agent-create-design',
            });
          } catch (error) {
            useDesignStore.getState().deleteDesign(designId);
            throw error;
          }
        }
        effects.changed({ kind: 'design-created', designId });
        const shouldOpen = open === true;
                                                                                   
                                                                       
        const tabId = shouldOpen
          ? useCanvasStore.getState().openAgentContentTab('design', designId, name)
          : null;
        const mutation = createDesignMutationClaim({
          operationId: context?.toolCallId,
          toolName: 'create_design',
          effect: 'created_design',
          designId,
          beforeVersion: null,
          afterVersion: design?.version ?? null,
          changed: true,
          expected: {
            name,
            assemblyMethod: method,
            regionCount: 0,
          },
        });

        return toolSuccess({
          designId,
          destinationProject: selectedProject?.name ?? null,
          name,
          assemblyMethod: method,
          goldenGateEnzyme: design?.goldenGateConfig?.enzyme ?? null,
          opened: shouldOpen,
          tabId,
          resourceUri: mutation.resourceUri,
          artifact: {
            type: 'design',
            designId,
            name,
            resourceUri: mutation.resourceUri,
            openAction: { tool: 'open_tab', type: 'design', entityId: designId, label: name },
          },
          mutation,
        });
      }),
  });
}

                                                                                        
export const createDesignTool = createCreateDesignTool([]);
