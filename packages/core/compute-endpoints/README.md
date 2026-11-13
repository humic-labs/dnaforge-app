# Compute endpoint integrations

DNAForge turns different hosted inference APIs into one durable job lifecycle:

`discover → validate → estimate → approve → submit → status → result → cancel`

The normalization stops at that lifecycle boundary. A manifest describes a
provider's native model inputs and outputs; it does not claim that unrelated
scientific models are interchangeable.

## Fastest path for a user

In the desktop app, open **Settings → Integrations → Add endpoint**.

- **Runpod Serverless** asks only for the endpoint name and endpoint ID. The API
  key is requested afterward and stored separately in the operating-system
  keychain.
- **Advanced manifest** accepts a schema-version-2 JSON manifest. The renderer
  validates it first, the sidecar validates it independently, and the app only
  installs it if both agree.

Installed manifests are profile-scoped. They survive relaunch and can be removed
from the same Integrations screen. A manifest never contains a secret.

## Choose a reusable driver

Use the protocol the endpoint actually speaks. Do not add a new driver just to
rename a provider.

| Driver         | Use it when                                                                                  | Lifecycle           |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| `http-job`     | A JSON API returns a job ID, exposes a status resource, and optionally supports cancellation | Asynchronous REST   |
| `nvcf`         | An endpoint follows NVIDIA Cloud Functions' `200`/`202` plus request-ID long-poll contract   | NVCF long-poll      |
| `mcp-tool-map` | An MCP server exposes tools that map onto DNAForge's eight compute operations                | Streamable HTTP MCP |

Provider-specific decoding belongs in a small, named result codec only when a
real scientific format must be recovered. Unknown output stays available as a
raw artifact instead of being silently discarded.

## Minimal asynchronous HTTP example

This example is intentionally provider-neutral. Replace every `example.test`
value, the tool metadata, status strings, disclosure, and legal URLs with the
real provider contract.

```json
{
  "schemaVersion": 2,
  "id": "acme-folding",
  "displayName": "Acme Folding",
  "summary": "Run the Acme folding endpoint through its asynchronous job API.",
  "docsUrl": "https://docs.example.test/folding",
  "keyPageUrl": "https://console.example.test/api-keys",
  "termsUrl": "https://example.test/terms",
  "privacyUrl": "https://example.test/privacy",
  "transport": "rest",
  "baseUrl": "https://api.example.test/v1",
  "driver": {
    "kind": "http-job",
    "submit": {
      "method": "POST",
      "idPath": "id",
      "bodyTemplate": { "input": "$settings", "label": "$label" }
    },
    "status": {
      "method": "GET",
      "pathTemplate": "/jobs/{remote_id}",
      "statePath": "status",
      "statusMap": {
        "waiting": "queued",
        "working": "running",
        "succeeded": "completed",
        "failed": "failed",
        "canceled": "canceled"
      }
    },
    "result": { "payloadPath": "output", "codec": "raw-json" },
    "cancel": {
      "method": "POST",
      "pathTemplate": "/jobs/{remote_id}/cancel",
      "statePath": "status"
    }
  },
  "auth": { "scheme": "bearer", "keyPrefix": "acme_" },
  "verify": { "method": "GET", "target": "/account", "expectKey": "id" },
  "catalog": "static",
  "jobModel": "async",
  "staging": "inline",
  "cost": "rate-card",
  "staticTools": [
    {
      "id": "fold",
      "displayName": "Protein fold",
      "path": "/jobs",
      "outputKind": "binary",
      "description": "Run Acme's native fold operation. Not yet live-qualified in DNAForge.",
      "keywords": ["protein", "fold", "structure"],
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sequence"],
        "properties": {
          "sequence": {
            "type": "string",
            "minLength": 1,
            "maxLength": 5000,
            "pattern": "^[A-Z]+$",
            "patternMessage": "must contain uppercase residue symbols only"
          }
        }
      }
    }
  ],
  "disclosure": "This sends job inputs to Acme Folding under your own Acme account. Acme Folding bills that account for execution; DNAForge does not charge for it.",
  "retentionNote": "Acme keeps completed results for 24 hours; import useful output promptly.",
  "cancellation": {
    "mode": "provider",
    "note": "Acme accepts cancellation for queued or running jobs."
  },
  "rateLimitRps": 2
}
```

The request body template may insert only `$settings`, `$tool_id`, `$label`, or
`$idempotency_key`. Paths must be same-origin relative paths. Credential and
routing headers are not accepted from a manifest.

## Input-schema subset

The declarative drivers evaluate a deliberately small, non-executable subset of
JSON Schema:

- `type`, `title`, `description`, `default`, and `enum`
- object `properties`, `required`, and boolean `additionalProperties`
- array `items`, `minItems`, and `maxItems`
- string `minLength`, `maxLength`, `pattern`, and `patternMessage`
- numeric `minimum` and `maximum`

Patterns must be anchored simple character-class expressions, such as
`^[A-Z]+$`. Arbitrary regular expressions, schema references, executable
extensions, environment access, local file access, cookies, and arbitrary
headers are rejected.

## What an integration must disclose

Every manifest must identify:

- the exact destination and credential scheme;
- who receives the submitted data and who is billed;
- result-retention behavior;
- whether cancellation stops work at the provider or is unavailable;
- whether each advertised tool is live-qualified, deterministically qualified,
  known to fail, or unqualified.

“Listed” is not the same as “live-qualified.” Keep that wording honest in the
tool description until a real paid journey has passed.

## Qualification ladder

An integration is ready only after the relevant levels pass:

1. **Manifest contract:** TypeScript and Python accept the same bounded data and
   reject unsafe paths, headers, placeholders, and schemas.
2. **Protocol fixture:** recorded or synthetic responses cover authentication,
   submit, every provider status, result decoding, cancellation, and failures.
3. **Desktop journey:** install/connect, relaunch persistence, consent, Jobs,
   completion or cancellation, import, and restart/reopen run in real Electron.
4. **Live provider journey:** a real organizational credential and paid endpoint
   prove the provider contract. Record the date and exact model/deployment.

Useful local checks from the repository root:

```sh
pnpm --dir packages/core/compute-endpoints test
pnpm --dir packages/core/compute-endpoints typecheck
cd apps/api && uv run pytest tests/test_compute*.py -q --no-cov
```

The billable Electron qualification is intentionally acknowledgement-gated; see
`e2e/electron/playwright.live-compute.config.ts` before running it.

## Current limitations

- `raw-json` preserves provider-native output but does not download an arbitrary
  URL contained inside it. Add a reviewed result codec with explicit host and
  size policy when imported files are required.
- Generic deployment export and a signed public manifest catalog are not yet
  implemented.
- OAuth is represented in the manifest model but has no production provider flow
  yet.
- GA4GH WES, MCP Tasks, and cloud-batch lifecycles require separate reusable
  drivers; they should still project into the same Jobs database.

The bundled Replicate manifest and the Runpod installer are the reference
`http-job` integrations. The NVIDIA manifest is the reference `nvcf`
integration, and Tamarind is the reference `mcp-tool-map` integration.
