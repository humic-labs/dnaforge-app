import type { JSONContent } from '@tiptap/core';

import { serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import {
  buildNotebookPackageMetadata,
  NOTEBOOK_PACKAGE_FORMAT_VERSION,
  serializeNotebookPackageMetadata,
} from '../../db/notebook-package';
import { TABLE_NOTEBOOK_BLOCK } from '../../shared/table-notebook-contract';
import type { AppScenario } from './types';

const PAGE_ID = 'fixture-notebook-content-extensions';
const TITLE = 'Notebook content extensions';
const WORKSPACE_ROOT = '/mock/test/workspace/notebook-content-extensions';
const PACKAGE_STEM = 'Notebook-content-extensions';
const PACKAGE_ROOT = `${WORKSPACE_ROOT}/${PACKAGE_STEM}`;
const MARKDOWN_FILE_NAME = `${PACKAGE_STEM}.md`;

function notebookContent(): JSONContent {
  const tableData = {
    name: 'Current table payload',
    rows: 2,
    cols: 3,
    columnLabels: ['Sample', 'Concentration', 'Status'],
    cells: [
      [
        { value: 'pUC19', type: 'text' },
        { value: '42 ng/µL', type: 'text' },
        { value: 'Ready', type: 'text' },
      ],
      [
        { value: 'GFP insert', type: 'text' },
        { value: '18 ng/µL', type: 'text' },
        { value: 'Review', type: 'text' },
      ],
    ],
  };

  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Supported table' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Version 1 is understood, so DNAForge uses the full table editor.',
          },
        ],
      },
      {
        type: 'embed',
        attrs: {
          type: TABLE_NOTEBOOK_BLOCK.type,
          version: TABLE_NOTEBOOK_BLOCK.currentVersion,
          refId: 'fixture-supported-table',
          data: tableData,
        },
      },
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Future table version' }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Version 2 is newer than this app, so DNAForge preserves it without guessing.',
          },
        ],
      },
      {
        type: 'embed',
        attrs: {
          type: TABLE_NOTEBOOK_BLOCK.type,
          version: TABLE_NOTEBOOK_BLOCK.currentVersion + 1,
          refId: 'fixture-future-table',
          data: {
            ...tableData,
            name: 'Future table payload',
            futureOnlySetting: 'preserved',
          },
        },
      },
    ],
  };
}

export function notebookContentExtensionsSession(): AppScenario {
  const content = notebookContent();
  const serialized = serializeNotebookMarkdown({
    identity: {
      id: PAGE_ID,
      title: TITLE,
      formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
    },
    content,
  });
  const metadata = buildNotebookPackageMetadata({
    id: PAGE_ID,
    title: TITLE,
    markdownFileName: MARKDOWN_FILE_NAME,
    updatedAt: '2026-08-26T12:00:00.000Z',
  });
  const files = Object.fromEntries([
    [`${PACKAGE_ROOT}/.forge/notebook.json`, serializeNotebookPackageMetadata(metadata)],
    [`${PACKAGE_ROOT}/${MARKDOWN_FILE_NAME}`, serialized.markdown],
    ...serialized.payloads.map((payload) => [
      `${PACKAGE_ROOT}/${payload.relativePath}`,
      payload.content,
    ]),
  ]);

  return {
    dev: {
      scenarioId: `${PAGE_ID}-${crypto.randomUUID()}`,
      initializeGit: true,
      initialGitCommitMessage: 'Initialize notebook content extensions proof workspace',
    },
    canvas: {
      tabs: [{ type: 'page', entityId: PAGE_ID, label: TITLE }],
      activeTabIndex: 0,
    },
    pages: {
      pages: [
        {
          id: PAGE_ID,
          title: TITLE,
          content,
        },
      ],
    },
    files,
    workspace: {
      folders: [{ path: WORKSPACE_ROOT, name: TITLE }],
      selectedPath: PACKAGE_ROOT,
    },
  };
}
