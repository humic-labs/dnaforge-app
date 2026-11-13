import { defineConfig } from 'orval';
import { existsSync } from 'node:fs';
import path from 'node:path';

const generatedRoot = path.resolve(
  process.env.ORVAL_OUTPUT_ROOT || 'packages/core/api-client/src/generated'
);
const schemaPath = path.resolve(process.env.OPENAPI_SPEC_PATH || 'apps/api/openapi.json');
const fetcherPath = path.resolve('packages/core/api-client/src/fetcher.ts');
const watchFormatHook =
  process.env.ORVAL_FORMAT_HOOK === '1'
    ? { afterAllFilesWrite: `prettier --write "${generatedRoot}/**/*.ts"` }
    : undefined;

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
      schemas: path.join(generatedRoot, 'models'),
      client: 'fetch',
      clean: true,
      override: {
        mutator: {
          path: fetcherPath,
          name: 'customFetch',
        },
      },
    },
  },

  waypointReactQuery: {
    input: {
      target: schemaPath,
    },
    output: {
      target: path.join(generatedRoot, 'react-query.ts'),
      schemas: path.join(generatedRoot, 'models'),
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
    hooks: watchFormatHook,
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
