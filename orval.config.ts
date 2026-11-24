import { defineConfig } from 'orval';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import path from 'node:path';

const generatedRoot = path.resolve(
  process.env.ORVAL_OUTPUT_ROOT || 'packages/core/api-client/src/generated'
);
const schemaPath = path.resolve(process.env.OPENAPI_SPEC_PATH || 'apps/api/openapi.json');
const fetcherPath = path.resolve('packages/core/api-client/src/fetcher.ts');
const modelsDirectory = path.join(generatedRoot, 'models');

function markTypeOnlyModelExports() {
  const indexPath = path.join(modelsDirectory, 'index.ts');
  const original = readFileSync(indexPath, 'utf8');
  const index = original.replace(
    /^export \* from (['"])(\.\/[^'"]+)\1;/gm,
    (statement, _quote, modelPath) => {
      const file = path.resolve(modelsDirectory, modelPath + '.ts');
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
      const typeOnly = source.statements.every(
        (node) =>
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
      );
      return typeOnly ? statement.replace('export *', 'export type *') : statement;
    }
  );
  if (index !== original) writeFileSync(indexPath, index);
}

const modelHooks = {
  afterAllFilesWrite: [
    markTypeOnlyModelExports,
    ...(process.env.ORVAL_FORMAT_HOOK === '1'
      ? [`prettier --write "${generatedRoot}/**/*.ts"`]
      : []),
  ],
};

const assemblyGraphApi = path.resolve('apps/desktop/src/features/assembly-graph/sidecar-api');
const assemblyGraphSchema = path.join(assemblyGraphApi, 'openapi.json');
const assemblyGraphRoot = path.resolve(
  process.env.ORVAL_ASSEMBLY_GRAPH_OUTPUT_ROOT || path.join(assemblyGraphApi, 'generated')
);

export default defineConfig({
  waypoint: {
    input: {
      target: schemaPath,
    },
    output: {
      target: path.join(generatedRoot, 'api.ts'),
      schemas: modelsDirectory,
      client: 'fetch',
      clean: true,
      override: {
        mutator: {
          path: fetcherPath,
          name: 'customFetch',
        },
      },
    },
    hooks: { afterAllFilesWrite: markTypeOnlyModelExports },
  },

  waypointReactQuery: {
    input: {
      target: schemaPath,
    },
    output: {
      target: path.join(generatedRoot, 'react-query.ts'),
      schemas: modelsDirectory,
      client: 'react-query',
      clean: false,
      override: {
        mutator: {
          path: fetcherPath,
          name: 'customFetch',
        },
        query: {
          useQuery: true,
          useMutation: true,
        },
      },
    },
    hooks: modelHooks,
  },

  ...(existsSync(assemblyGraphSchema)
    ? {
        assemblyGraph: {
          input: {
            target: assemblyGraphSchema,
          },
          output: {
            target: path.join(assemblyGraphRoot, 'api.ts'),
            schemas: path.join(assemblyGraphRoot, 'models'),
            client: 'fetch',
            clean: true,
            override: {
              mutator: {
                path: path.join(assemblyGraphApi, 'fetch.ts'),
                name: 'customFetch',
              },
            },
          },
          hooks: {
            afterAllFilesWrite: `"${path.resolve('node_modules/.bin/prettier')}" --ignore-path .prettierignore --write`,
          },
        },
      }
    : {}),
});
