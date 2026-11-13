import type { PlatformBridge } from '../../platform';
import { notebookPackagePaths } from '../../db/notebook-package';
import { isAdoptableMarkdownPath } from '../../shared/markdown-notebook';
import { normalizePathForBoundary, pathIsAtOrUnder } from '../../shared/path-boundary';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { waitForNativeFileDocumentReadiness } from '../../features/workspace/public/file-document-client';
import { openWorkspaceFromSource } from '../../features/workspace-loader/open-workspace-from-source';
import { runWorkspaceReconcileOperation } from '../../services/workspace-operations';
import type { AppScenario } from './types';

export async function settleMarkdownScenarioBaseline(
  bridge: PlatformBridge,
  scenario: AppScenario,
  commit: (root: string, message: string, assertCurrent: () => void) => Promise<void>,
  apply: (paths: Map<string, string>, assertCurrent: () => void) => Promise<void>
): Promise<void> {
  const previous = useWorkspaceStore.getState();
  const readPresentation = () => {
    const state = useWorkspaceStore.getState();
    return {
      selectedPath: state.selectedPath,
      revealRequestId: state.revealRequestId,
      revealTargetPath: state.revealTargetPath,
      revealTargetPaths: [...state.revealTargetPaths],
      activeWorkspaceFile: state.activeWorkspaceFile,
    };
  };
  const samePresentation = (
    left: ReturnType<typeof readPresentation>,
    right: ReturnType<typeof readPresentation>
  ) =>
    left.selectedPath === right.selectedPath &&
    left.revealRequestId === right.revealRequestId &&
    left.revealTargetPath === right.revealTargetPath &&
    left.activeWorkspaceFile === right.activeWorkspaceFile &&
    left.revealTargetPaths.length === right.revealTargetPaths.length &&
    left.revealTargetPaths.every((path, index) => path === right.revealTargetPaths[index]);
  const priorPresentation = readPresentation();
  let expectedPresentation = priorPresentation;
  const expectedMounts = new Map(
    previous.folders.map((folder) => [normalizePathForBoundary(folder.path), folder.mountRequest])
  );
  const ownedMounts = new Map<string, { request: number }>();
  let opening: string | undefined;
  let superseded = false;
  let presentationSuperseded = false;
  let ownsPresentation = false;
  let publishingPresentation = false;
  const mountsAreCurrent = () => {
    const folders = useWorkspaceStore.getState().folders;
    return (
      folders.every((folder) => {
        const key = normalizePathForBoundary(folder.path);
        return expectedMounts.has(key)
          ? expectedMounts.get(key) === folder.mountRequest
          : key === opening;
      }) &&
      [...expectedMounts].every(([key, request]) =>
        folders.some(
          (folder) =>
            normalizePathForBoundary(folder.path) === key && folder.mountRequest === request
        )
      )
    );
  };
  const unsubscribe = useWorkspaceStore.subscribe(() => {
    if (!mountsAreCurrent()) superseded = true;
    const current = readPresentation();
    if (samePresentation(current, expectedPresentation)) return;
    const ownReveal =
      opening &&
      ownedMounts.has(opening) &&
      current.selectedPath !== null &&
      normalizePathForBoundary(current.selectedPath) === opening &&
      current.revealRequestId === expectedPresentation.revealRequestId + 1 &&
      current.revealTargetPath === current.selectedPath &&
      current.revealTargetPaths.length === 1 &&
      current.revealTargetPaths[0] === current.selectedPath &&
      current.activeWorkspaceFile === expectedPresentation.activeWorkspaceFile;
    if (publishingPresentation || ownReveal) {
      expectedPresentation = current;
      if (ownReveal) ownsPresentation = true;
    } else {
      superseded = true;
      presentationSuperseded = true;
    }
  });
  const assertCurrent = (sourceRoot?: string) => {
    if (
      superseded ||
      !mountsAreCurrent() ||
      !samePresentation(readPresentation(), expectedPresentation)
    )
      throw new Error('DevPanel Markdown baseline was superseded by a workspace change.');
    if (sourceRoot) {
      const key = normalizePathForBoundary(sourceRoot);
      const folder = useWorkspaceStore
        .getState()
        .folders.find((entry) => normalizePathForBoundary(entry.path) === key);
      if (
        !folder ||
        folder.pinned ||
        !expectedMounts.has(key) ||
        folder.mountRequest !== expectedMounts.get(key)
      )
        throw new Error('The DevPanel Markdown source mount changed.');
    }
  };
  let retired = false;
  const retireOwnedMounts = async () => {
    if (retired) return;
    retired = true;
    for (const [key, owned] of ownedMounts) {
      const state = useWorkspaceStore.getState();
      const current = state.folders.find((folder) => normalizePathForBoundary(folder.path) === key);
      if (current?.mountRequest !== owned.request) continue;
      expectedMounts.delete(key);
      state.removeFolder(current.path);
    }
    if (
      ownsPresentation &&
      !presentationSuperseded &&
      samePresentation(readPresentation(), expectedPresentation)
    ) {
      const priorSelectedPath = priorPresentation.selectedPath;
      const priorRoot =
        priorSelectedPath &&
        previous.folders.find((folder) => pathIsAtOrUnder(priorSelectedPath, folder.path));
      const priorRootSurvives =
        !priorRoot ||
        useWorkspaceStore
          .getState()
          .folders.some(
            (folder) =>
              normalizePathForBoundary(folder.path) === normalizePathForBoundary(priorRoot.path) &&
              folder.mountRequest === priorRoot.mountRequest
          );
      publishingPresentation = true;
      try {
        useWorkspaceStore.setState({
          selectedPath: priorRootSurvives ? priorPresentation.selectedPath : null,
          revealTargetPath: priorRootSurvives ? priorPresentation.revealTargetPath : null,
          revealTargetPaths: priorRootSurvives ? priorPresentation.revealTargetPaths : [],
          revealRequestId: useWorkspaceStore.getState().revealRequestId + 1,
        });
      } finally {
        publishingPresentation = false;
      }
    }
    await waitForNativeFileDocumentReadiness();
  };
  const paths = new Map<string, string>();
  try {
    for (const folder of scenario.workspace?.folders ?? []) {
      if (folder.pinned) continue;
      assertCurrent();
      const key = normalizePathForBoundary(folder.path);
      if (!expectedMounts.has(key)) {
        opening = key;
        try {
          const opened = await openWorkspaceFromSource(
            { kind: 'local-folder', path: folder.path, name: folder.name },
            { inPlace: true },
            {
              onWorkspaceCommitted: ({ instance }) => {
                const mounted = useWorkspaceStore
                  .getState()
                  .folders.find((entry) => normalizePathForBoundary(entry.path) === key);
                if (
                  instance.rootFolders.length !== 1 ||
                  normalizePathForBoundary(instance.rootFolders[0].path) !== key ||
                  mounted?.mountRequest === undefined
                )
                  throw new Error('The DevPanel Markdown mount has no loader identity.');
                expectedMounts.set(key, mounted.mountRequest);
                ownedMounts.set(key, { request: mounted.mountRequest });
              },
            }
          );
          if (opened.superseded || !ownedMounts.has(key))
            throw new Error('DevPanel Markdown baseline was superseded by a workspace change.');
        } finally {
          opening = undefined;
        }
      }
      assertCurrent(folder.path);
      await waitForNativeFileDocumentReadiness();
      assertCurrent(folder.path);
      for (const path of Object.keys(scenario.files ?? {})) {
        if (
          !pathIsAtOrUnder(path, folder.path) ||
          !isAdoptableMarkdownPath(path.slice(folder.path.length + 1))
        )
          continue;
        assertCurrent(folder.path);
        if (!bridge.notebook.adoptMarkdown)
          throw new Error('Native Markdown adoption is unavailable.');
        const adopted = await bridge.notebook.adoptMarkdown({ workspaceRoot: folder.path, path });
        assertCurrent(folder.path);
        if (adopted) paths.set(path, notebookPackagePaths(adopted.path).markdownPath);
      }
      assertCurrent(folder.path);
      await runWorkspaceReconcileOperation({
        workspaceRoot: folder.path,
        catalogSource: 'working-tree',
        healManagedHead: false,
        strict: true,
        displayDelivery: 'optional',
      });
      assertCurrent(folder.path);
    }
    const message =
      scenario.dev?.initialGitCommitMessage?.trim() || 'Initialize dev scenario workspace';
    for (const folder of scenario.workspace?.folders ?? []) {
      const assertSourceCurrent = () => assertCurrent(folder.pinned ? undefined : folder.path);
      assertSourceCurrent();
      await commit(folder.path, message, assertSourceCurrent);
      assertSourceCurrent();
    }
    await retireOwnedMounts();
    assertCurrent();
    await apply(paths, assertCurrent);
  } finally {
    try {
      await retireOwnedMounts();
    } finally {
      unsubscribe();
    }
  }
}
