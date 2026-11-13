"""Wire contract for workflow preparation, including empty and prior-run history."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Output(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkflowDemand(_Output):
    level: str
    rationale: str
    signals: list[str]


class WorkflowResources(_Output):
    manifest: str
    contract: str
    runSummary: str
    latestRun: str


class WorkflowCommand(_Output):
    cwd: str
    argv: list[str]
    shell: str


class WorkflowStep(_Output):
    id: str
    kind: str
    execution_boundary: str
    description: str
    surface: str | None = None
    tool: str | None = None
    uri_pattern: str | None = None


class BoundaryCount(_Output):
    steps: int = Field(ge=0)
    step_ids: list[str]


class WorkflowBoundaries(_Output):
    boundaries: dict[str, BoundaryCount]
    missing: list[str]


class LatestRun(_Output):
    outcome: str | None
    classification: str | None
    failedStage: str | None
    durationMs: float | None
    path: str | None
    nextActions: list[str]


class HistoryWorkflow(_Output):
    id: str
    title: str | None
    mode: str | None
    maturity: str | None
    demand_level: str


class HistoryLatest(_Output):
    path: str | None
    outcome: str | None
    classification: str | None
    failed_stage: str | None
    duration_ms: float | None


class WorkflowHistory(_Output):
    workflow: HistoryWorkflow
    runs: int = Field(ge=0)
    passed_runs: int = Field(ge=0)
    failed_runs: int = Field(ge=0)
    successful_tool_flows: int = Field(ge=0)
    failed_tool_flows: int = Field(ge=0)
    latest: HistoryLatest | None


class WorkflowPreparationOutput(_Output):
    ok: Literal[True]
    workflowId: str
    title: str | None
    mode: str | None
    maturity: str | None
    demand: WorkflowDemand | None
    resources: WorkflowResources
    command: WorkflowCommand
    expectedAppChanges: list[str]
    requiredPrimitives: list[str]
    verificationChannels: list[str]
    workflowSteps: list[WorkflowStep]
    workflowBoundaries: WorkflowBoundaries
    latestRun: LatestRun | None
    runHistory: WorkflowHistory
    operatorNotes: list[str]
