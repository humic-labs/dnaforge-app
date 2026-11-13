# DNAForge Python Sidecar

Local bioinformatics compute service supervised by the DNAForge desktop app.

## Quick Start

### Desktop app (normal path)

```bash
cd apps/desktop
npm run dev
```

Electron creates a fresh launch session, starts the sidecar, and authenticates
desktop requests automatically. The session secret is never exposed to renderer
JavaScript.

### Standalone sidecar development

```bash
cd apps/api
uv run python run_server.py --dev-auth --reload --port 8000
```

The command prints the temporary `X-DNAForge-Session` request header and a
complete `curl` command for a protected request. Copy that printed command to
confirm the authenticated `/services/` catalog responds. Only
`GET /health` and `GET /ready` are public; every other path, including API
documentation and unknown routes, requires that header.

Plain `/health` returns only liveness and no token-derived verifier. Electron
presents its candidate session only to the exact assigned loopback health URL,
with redirects disabled: authenticated detail means the listener is owned and
`401` means it is an orphan. Supplying the session header returns the detailed
version, grant, and route-feature diagnostics used by maintained developer
gates.

To own the credential instead of using an auto-generated one, set it before
launch. This is the supported path for containers, automated clients, and
prestarted local sidecars:

```bash
export DNAFORGE_MCP_SESSION_TOKEN="$(openssl rand -hex 32)"
uv run python run_server.py --reload --port 8000
curl -H "X-DNAForge-Session: $DNAFORGE_MCP_SESSION_TOKEN" http://127.0.0.1:8000/services/
```

Restart the process after changing the token. Existing clients and CLI
companions intentionally keep the old generation and must reconnect.

### Authentication troubleshooting

| Result | Cause | Fix |
| --- | --- | --- |
| `BAD_SESSION` | The protected request omitted the header or used a wrong, duplicate, or stale token | Copy the current launcher's printed header; after restart, reconnect instead of replaying the old credential |
| `MCP_SESSION_NOT_CONFIGURED` | The server was started through raw Uvicorn or without an explicit token | Restart with `run_server.py --dev-auth`, or set `DNAFORGE_MCP_SESSION_TOKEN` before launch |
| `SIDECAR_SESSION_UNAVAILABLE` | Electron has revoked the old generation and the replacement is not ready | Wait for the compute service to become ready; retry only with the new generation |
| Authenticated ownership rejection | The listener on the port belongs to an old, incompatible, or differently owned process | Stop that listener and relaunch DNAForge or the standalone sidecar with the expected token |

## Development

### Run Tests

```bash
# With venv activated
pytest                    # Run all tests
pytest -v                 # Verbose output
pytest --cov              # With coverage report
```

### Linting & Formatting

```bash
ruff check src/           # Check for issues
ruff check --fix src/     # Auto-fix issues
ruff format src/          # Format code
```

### Nx Commands

```bash
npx nx run molbio-api:serve       # Start dev server
npx nx run molbio-api:serve:docker  # Start via Docker
npx nx run molbio-api:test        # Run tests
npx nx run molbio-api:lint        # Lint code
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Public process liveness; authenticated calls include the desktop handshake |
| `GET /ready` | Public startup readiness |
| all other routes | Current launch session, or the existing persistent-agent key on delegated agent routes |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DNAFORGE_MCP_SESSION_TOKEN` | Yes, except public probes | Launch-owned sidecar session; Electron supplies it automatically |
| `DNAFORGE_SIDECAR_SESSION_GENERATION` | No | Main-process generation number used in safe local diagnostics |
| `DNAFORGE_ALLOWED_RENDERER_ORIGIN` | No | Exact browser origin allowed by CORS; Electron sets the Vite origin in development and `null` when packaged. Unset denies every browser origin. |

## Project Structure

```
apps/api/
├── src/
│   ├── main.py           # FastAPI app entry
│   ├── database.py       # Database connection
│   ├── routes/           # API route handlers
│   │   └── health.py
│   └── chat/             # AI chat module
│       ├── agent.py      # LangGraph agent
│       ├── router.py     # Chat endpoints
│       └── tools.py      # Agent tools
├── tests/
│   ├── conftest.py       # Test fixtures
│   └── test_health.py    # Health endpoint tests
├── Dockerfile            # Container build
├── requirements.txt      # Production deps
├── requirements-dev.txt  # Dev deps (includes test/lint)
└── pyproject.toml        # Python project config
```

## Docker Details

### Build Image

```bash
docker build -t waypoint-api ./apps/api
```

### Run Standalone

```bash
export DNAFORGE_MCP_SESSION_TOKEN="$(openssl rand -hex 32)"
docker run --rm -d -p 8000:8000 -e DNAFORGE_MCP_SESSION_TOKEN waypoint-api
for attempt in $(seq 1 30); do
  if curl -sf http://localhost:8000/ready >/dev/null; then break; fi
  sleep 1
done
curl -sf http://localhost:8000/ready >/dev/null
curl -H "X-DNAForge-Session: $DNAFORGE_MCP_SESSION_TOKEN" \
  http://localhost:8000/services/
```

### Health Check

The container includes a readiness check that pings `/ready` every 30s. A
container started without `DNAFORGE_MCP_SESSION_TOKEN` reports unhealthy.

## Architecture Notes

- **Database**: Optional - API runs without it (DB-dependent endpoints will error)
- **AI Chat**: Requires `ANTHROPIC_API_KEY` for LangGraph agent features
- **Error Tracking**: owned by Electron main for desktop launches. Do not
  initialize Sentry inside the frozen Python sidecar; main supervises sidecar
  lifecycle, stderr, health, and restart telemetry.
