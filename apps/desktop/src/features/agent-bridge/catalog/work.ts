import {
  createWorkTasksTool,
  workTasksSchema,
  workTasksOutputSchema,
  WORK_TASKS_DESCRIPTION,
} from '../../ai/public/tools/work-tasks';
import { defineRendererToolCatalog, resultSdkRendererTool } from './types';

export const workTools = defineRendererToolCatalog({
  work_tasks: {
    name: 'work_tasks',
    description: WORK_TASKS_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: workTasksSchema,
    outputSchema: workTasksOutputSchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities: [
        'query',
        'inspect',
        'history',
        'occurrences',
        'reminders',
        'dates',
      ].includes((args as { operation: { kind: string } }).operation.kind)
        ? []
        : ['write-workspace'],
    }),
    execution: resultSdkRendererTool((context) => createWorkTasksTool(context.folders)),
  },
});
