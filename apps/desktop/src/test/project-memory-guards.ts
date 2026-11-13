import { expect } from 'vitest';
import { getMockFileContent } from './platform-mocks';

const PROJECT_MEMORY_FILES = [
  'manifest.json',
  'events.jsonl',
  'entities.jsonl',
  'files.jsonl',
  'links.jsonl',
];

export function expectNoProjectMemoryFilesWritten(workspaceRoot: string): void {
  for (const fileName of PROJECT_MEMORY_FILES) {
    expect(getMockFileContent(`${workspaceRoot}/.waypoint/project-memory/${fileName}`)).toBeNull();
  }
}
