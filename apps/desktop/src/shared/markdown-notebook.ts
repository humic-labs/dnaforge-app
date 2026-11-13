export interface MarkdownNotebookAdoptionRequest {
  workspaceRoot: string;
  path: string;
}

export interface MarkdownNotebookAdoption {
  workspaceRoot: string;
  sourcePath: string;
  path: string;
  pageId: string;
  title: string;
}

export interface MarkdownNotebookAdoptionIssue {
  workspaceRoot: string;
  path: string;
  message: string;
}

const INSTRUCTION_NAMES = new Set(['agents.md', 'claude.md', 'claude.local.md', 'skill.md']);

export function isAdoptableMarkdownPath(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/');
  const name = segments.at(-1)?.toLowerCase() ?? '';
  return (
    /\.(md|markdown)$/i.test(name) &&
    !INSTRUCTION_NAMES.has(name) &&
    !segments.some(
      (part) => part.startsWith('.') || part === 'node_modules' || part === '__pycache__'
    )
  );
}
