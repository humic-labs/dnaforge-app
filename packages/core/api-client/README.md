# @waypoint/api-client

Type-safe API client for the DNAForge FastAPI service, auto-generated from
OpenAPI spec using [Orval](https://orval.dev/).

## Features

- **Type-safe**: Full TypeScript types for all API endpoints, request bodies,
  and responses
- **Two client flavors**:
  - Plain fetch client for simple usage
  - React Query hooks for React apps
- **Error handling**: API errors throw with structured `ApiError` type
- **Auto-generated**: Run `npm run api:generate` whenever the API changes

## Installation

```bash
# From the monorepo root
npm install
```

## Usage

### Plain Fetch Client

```typescript
import { pairwiseAlignment, healthCheck } from '@waypoint/api-client';

// Simple GET request
const health = await healthCheck();
console.log(health.data.status);

// POST with typed request body
const result = await pairwiseAlignment({
  query: 'ATCGATCG',
  reference: 'ATCGATCG',
  algorithm: 'auto',
});
console.log(result.data.identity); // Fully typed response
```

### React Query Hooks

```typescript
import {
  useHealthCheck,
  usePairwiseAlignment,
} from '@waypoint/api-client/react-query';

function AlignmentComponent() {
  // Query hook
  const { data: health, isLoading } = useHealthCheck();

  // Mutation hook
  const alignment = usePairwiseAlignment();

  const handleAlign = () => {
    alignment.mutate({
      data: {
        query: 'ATCGATCG',
        reference: 'ATCGATCG',
      },
    });
  };

  if (alignment.isSuccess) {
    console.log(alignment.data.data.identity);
  }
}
```

### Type-only Imports

```typescript
import type {
  AlignmentResult,
  PairwiseAlignmentRequest,
} from '@waypoint/api-client/models';

function formatAlignment(result: AlignmentResult): string {
  return `Identity: ${result.identity}%`;
}
```

## Error Handling

API errors are thrown as `ApiError` objects:

```typescript
import {
  pairwiseAlignment,
  isApiError,
  type ApiError,
} from '@waypoint/api-client';

try {
  await pairwiseAlignment({ query: 'X', reference: 'Y' }); // Invalid sequences
} catch (error) {
  if (isApiError(error)) {
    console.error(`API Error ${error.status}: ${error.detail}`);
    // error.status: 422
    // error.detail: "Invalid characters in sequence"
    // error.body: Full response body
  }
}
```

## Configuration

### Runtime URL and headers

Bind each endpoint to a client and pass its options to generated calls:

```typescript
import { createApiClient, healthCheck } from '@waypoint/api-client';

const client = createApiClient({
  baseUrl: await platform().config.getApiUrl(),
});
const response = await healthCheck(
  client.options({ signal: AbortSignal.timeout(5000) })
);
```

The client captures a normalized configuration. Its options preserve request
headers, abort signals and other fetch options while carrying that configuration
through generated calls. The fetcher consumes the configuration before network
dispatch. Independent clients never change each other's destination or
transport. A main-process client can supply its authenticated `fetch` adapter at
creation. Renderer clients do not read or manufacture session credentials;
native request handling supplies the current session. The fetcher strips
caller-supplied session headers and strips local agent identity/capability
headers on remote destinations.

`configureApiClient` remains available for compatibility. The desktop platform
initialization owns that default once; feature callers use explicit clients. A
direct `customFetch` call can also provide its existing third configuration
argument, which takes precedence over bound options and the default. Tests using
the default reset it with `resetApiClientConfigurationForTests()`.

This fails closed in Electron if configuration is missing; it does not guess
port 8000. Non-Electron tests and web/SSR callers retain these fallbacks:

| Environment          | Variable       | Example                 |
| -------------------- | -------------- | ----------------------- |
| Vite (web)           | `VITE_API_URL` | `http://localhost:8000` |
| Node (tests/SSR)     | `API_URL`      | `http://localhost:8000` |
| Non-Electron default | -              | `http://localhost:8000` |

## Regenerating the Client

When the FastAPI service changes:

```bash
# From monorepo root
npm run api:generate

# Or with watch mode
npm run api:generate:watch
```

This runs Orval against the checked-in `apps/api/openapi.json`, then formats the
generated tree. No sidecar process or live port is involved.

### Updating the source schema

Export the complete FastAPI schema without entering the application lifespan,
then regenerate:

```bash
cd apps/api && .venv/bin/python scripts/export_openapi.py --output openapi.json
cd ../.. && npm run api:generate
pnpm arch:check
```

The architecture proof exports the schema again, verifies exact equality,
generates the Orval client twice, compares the two raw trees, formats one tree,
compares all files with the committed client, and compiles the package.

## Package Exports

| Import                             | Description                  |
| ---------------------------------- | ---------------------------- |
| `@waypoint/api-client`             | Plain fetch client functions |
| `@waypoint/api-client/react-query` | React Query hooks            |
| `@waypoint/api-client/models`      | TypeScript types only        |

## Representative Generated Endpoints

The generated client covers the complete committed OpenAPI schema. These are a
small sample of common calls, not the full endpoint inventory.

| Function            | Method | Path                              | Description               |
| ------------------- | ------ | --------------------------------- | ------------------------- |
| `healthCheck`       | GET    | `/health`                         | Health check              |
| `pairwiseAlignment` | POST   | `/api/tools/alignment/pairwise`   | Align two sequences       |
| `multipleAlignment` | POST   | `/api/tools/alignment/multiple`   | Align multiple sequences  |
| `getAlgorithms`     | GET    | `/api/tools/alignment/algorithms` | List alignment algorithms |
| `alignmentHealth`   | GET    | `/api/tools/alignment/health`     | Check MAFFT availability  |

## Development

```bash
# Run tests
npm test

# Watch mode
npm test -- --watch

# Generate client
npm run generate
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     React Components                         │
│   ┌─────────────────────┐   ┌─────────────────────────────┐ │
│   │  Plain fetch client │   │   React Query hooks         │ │
│   │  (api.ts)          │   │   (react-query.ts)          │ │
│   └──────────┬──────────┘   └──────────────┬──────────────┘ │
│              │                             │                 │
│              └──────────┬──────────────────┘                 │
│                         │                                    │
│              ┌──────────▼──────────┐                         │
│              │   customFetch()     │                         │
│              │   (fetcher.ts)      │                         │
│              └──────────┬──────────┘                         │
│                         │                                    │
└─────────────────────────┼────────────────────────────────────┘
                          │
                          ▼
                 ┌────────────────┐
                 │  FastAPI       │
                 │  localhost:8000│
                 └────────────────┘
```

## Files

```
packages/core/api-client/
├── src/
│   ├── index.ts              # Main export (re-exports api.ts)
│   ├── fetcher.ts            # Custom fetch with error handling
│   ├── fetcher.test.ts       # Fetcher unit tests
│   └── generated/            # Auto-generated by Orval
│       ├── api.ts            # Plain fetch client
│       ├── react-query.ts    # React Query hooks
│       └── models/           # TypeScript types
├── package.json
└── README.md
```
