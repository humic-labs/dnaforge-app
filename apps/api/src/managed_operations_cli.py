"""Explicit command-line client for application-owned operations."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from contextlib import nullcontext
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx
from dnaforge_annotation.contract import AnnotationRequest
from dnaforge_annotation.files import read_single_fasta
from dnaforge_annotation.receipt import AnnotationRunReceiptV1
from pydantic import ValidationError

from .alignment_index_operation_contract import AlignmentIndexRequest
from .annotation_document_cli import (
    DOCUMENT_ADMISSION_REFUSALS,
    document_apply_exit_code,
    read_annotation_document_selection,
)
from .annotation_document_contract import AnnotationDocumentTarget
from .annotation_document_responses import (
    AnnotationDocumentApplyResponse,
    AnnotationDocumentInspection,
)
from .annotation_operation_contract import annotation_input_revision
from .msa_operation_contract import (
    MAX_MSA_TIMEOUT_SECONDS,
    MsaAlgorithm,
    MultipleSequenceAlignmentInput,
    multiple_sequence_alignment_input_revision,
)
from .operation_connection import (
    operation_runtime_directory,
    prune_dead_operation_connections,
)
from .variant_source_operation_contract import (
    VariantReferenceIdentity,
    VariantSourceRequest,
)

_MAX_RECEIPT_BYTES = 32 * 1024 * 1024
_MAX_OPERATION_REQUEST_BYTES = 16 * 1024 * 1024
_MAX_MSA_FASTA_BYTES = 2 * 1024 * 1024
_OPERATION_KIND_SLUG = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")


class ManagedOperationRequestError(ValueError):
    def __init__(self, message: str, code: object):
        super().__init__(message)
        self.code = code if isinstance(code, str) else None


def _parse_variant_reference(value: str) -> VariantReferenceIdentity:
    name, separator, length_text = value.rpartition(":")
    try:
        if not separator or not name or not length_text.isdecimal():
            raise ValueError
        return VariantReferenceIdentity(name=name, length=int(length_text))
    except (ValidationError, ValueError) as exc:
        raise argparse.ArgumentTypeError(
            "Reference must use NAME:LENGTH with a nonempty name and positive integer length."
        ) from exc


@dataclass(frozen=True)
class OperationConnection:
    url: str
    session_token: str
    operation_token: str
    scope_id: str
    owner_id: str
    mcp_stdio: bool = False

    @classmethod
    def read(cls, path: Path) -> OperationConnection:
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError as exc:
            raise ValueError(
                "Cannot open the runtime connection file; start or connect to a managed runtime."
            ) from exc
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError("The runtime connection must be a regular file.")
            if os.name != "nt" and (
                metadata.st_mode & 0o077 or metadata.st_uid != os.getuid()
            ):
                raise ValueError(
                    "Runtime connection file permissions must allow access only by its owner (0600)."
                )
            if metadata.st_size > 16_384:
                raise ValueError("The runtime connection file is too large.")
            try:
                body = json.load(source)
            except (ValueError, UnicodeError) as exc:
                raise ValueError(
                    "The runtime connection file is not valid JSON."
                ) from exc
        fields = ("url", "session_token", "operation_token", "scope_id", "owner_id")
        if (
            not isinstance(body, dict)
            or body.get("version") != 1
            or any(
                not isinstance(body.get(name), str) or not body[name] for name in fields
            )
        ):
            raise ValueError(
                "The runtime connection file has an unsupported or incomplete contract."
            )
        url = urlsplit(body["url"])
        if (
            url.scheme != "http"
            or url.hostname not in {"127.0.0.1", "::1"}
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in {"", "/"}
        ):
            raise ValueError(
                "The managed runtime must use an explicit HTTP loopback address."
            )
        mcp_stdio = body.get("mcp_stdio", False)
        if not isinstance(mcp_stdio, bool):
            raise ValueError(
                "The runtime connection file has an invalid MCP availability marker."
            )
        return cls(
            **{name: body[name] for name in fields},
            mcp_stdio=mcp_stdio,
        )


def registered_connections() -> list[tuple[str, OperationConnection]]:
    directory = operation_runtime_directory()
    prune_dead_operation_connections(directory)
    paths = list(islice(directory.glob("*.connection.json"), 65))
    if len(paths) > 64:
        raise ValueError(
            "Too many live runtimes are registered; select an explicit --connection file."
        )
    return [
        (path.name.removesuffix(".connection.json"), OperationConnection.read(path))
        for path in sorted(paths)
    ]


def describe_runtimes(candidates: list[tuple[str, OperationConnection]]) -> str:
    return ", ".join(f"{key} ({connection.scope_id})" for key, connection in candidates)


def resolve_connection(path: Path | None, runtime: str | None) -> OperationConnection:
    if path is not None:
        return OperationConnection.read(path)
    configured = os.environ.get("DNAFORGE_OPERATION_CONNECTION_FILE")
    if configured and runtime is None:
        return OperationConnection.read(Path(configured).expanduser())
    candidates = registered_connections()
    if runtime is not None:
        exact = [connection for key, connection in candidates if key == runtime]
        candidates = (
            [(runtime, connection) for connection in exact]
            if exact
            else [item for item in candidates if item[1].scope_id == runtime]
        )
    if not candidates:
        raise ValueError(
            "No matching local runtime was found. Open DNAForge or explicitly start a managed runtime; use runtimes to list registered names."
        )
    if len(candidates) != 1:
        raise ValueError(
            "Several local runtimes are registered; select --runtime NAME or its unique ID: "
            + describe_runtimes(candidates)
        )
    return candidates[0][1]


class ManagedOperationsClient:
    def __init__(self, connection: OperationConnection):
        self.connection = connection

    def request(self, method: str, path: str, *, params=None, body=None) -> Any:
        if path != "/operations" and not path.startswith("/operations/"):
            raise ValueError(
                "Managed operation requests must use the operation surface."
            )
        with httpx.Client(
            base_url=self.connection.url,
            timeout=30,
            follow_redirects=False,
            trust_env=False,
            headers={
                "X-DNAForge-Session": self.connection.session_token,
                "X-DNAForge-Operation-Authority": self.connection.operation_token,
                "X-DNAForge-Operation-Channel": "managed_cli",
            },
        ) as client:
            try:
                with client.stream(method, path, params=params, json=body) as response:
                    chunks = []
                    size = 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 32 * 1024 * 1024:
                            raise ValueError(
                                "The operation response exceeds the retained-result limit."
                            )
                        chunks.append(chunk)
                    payload = b"".join(chunks)
                    if 300 <= response.status_code < 400:
                        raise ValueError(
                            "The runtime redirected the request; no credentials were forwarded."
                        )
                    try:
                        result = json.loads(payload)
                    except ValueError as exc:
                        raise ValueError(
                            "The managed runtime returned an invalid JSON response."
                        ) from exc
                    if not response.is_success:
                        detail = (
                            result.get("detail", result)
                            if isinstance(result, dict)
                            else {}
                        )
                        message = (
                            detail.get("message") if isinstance(detail, dict) else None
                        )
                        raise ManagedOperationRequestError(
                            message
                            or f"The managed runtime refused the request (HTTP {response.status_code}).",
                            detail.get("code") if isinstance(detail, dict) else None,
                        )
                    return result
            except httpx.HTTPError as exc:
                raise ValueError(
                    "The managed runtime is unavailable; reconnect to its current connection file."
                ) from exc


def read_receipt(path: str) -> AnnotationRunReceiptV1:
    try:
        if path == "-":
            content = sys.stdin.buffer.read(_MAX_RECEIPT_BYTES + 1)
        else:
            with Path(path).open("rb") as source:
                content = source.read(_MAX_RECEIPT_BYTES + 1)
    except OSError as exc:
        raise ValueError("Cannot read the annotation receipt.") from exc
    if len(content) > _MAX_RECEIPT_BYTES:
        raise ValueError("The annotation receipt is too large.")
    try:
        return AnnotationRunReceiptV1.model_validate_json(content)
    except ValidationError as exc:
        raise ValueError("The annotation receipt is invalid or unsupported.") from exc


def read_operation_request(path: str) -> dict[str, Any]:
    try:
        if path == "-":
            content = sys.stdin.buffer.read(_MAX_OPERATION_REQUEST_BYTES + 1)
        else:
            with Path(path).open("rb") as source:
                content = source.read(_MAX_OPERATION_REQUEST_BYTES + 1)
    except OSError as exc:
        raise ValueError("Cannot read the managed operation request.") from exc
    if len(content) > _MAX_OPERATION_REQUEST_BYTES:
        raise ValueError("The managed operation request is too large.")
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError) as exc:
        raise ValueError("The managed operation request is not valid JSON.") from exc
    if not isinstance(value, dict):
        raise ValueError("The managed operation request must be a JSON object.")
    return value


def read_msa_fasta(path: str) -> list[dict[str, str]]:
    try:
        if path == "-":
            content = sys.stdin.buffer.read(_MAX_MSA_FASTA_BYTES + 1)
        else:
            with Path(path).open("rb") as source:
                content = source.read(_MAX_MSA_FASTA_BYTES + 1)
    except OSError as exc:
        raise ValueError("Cannot read the alignment FASTA input.") from exc
    if len(content) > _MAX_MSA_FASTA_BYTES:
        raise ValueError("The alignment FASTA input is too large.")
    try:
        text = content.decode("utf-8")
    except UnicodeError as exc:
        raise ValueError("The alignment FASTA input must be UTF-8 text.") from exc

    records: list[dict[str, str]] = []
    current_id: str | None = None
    current_name: str | None = None
    sequence_parts: list[str] = []

    def finish_record() -> None:
        nonlocal current_id, current_name, sequence_parts
        if current_id is None:
            return
        record = {"id": current_id, "sequence": "".join(sequence_parts)}
        if current_name is not None:
            record["name"] = current_name
        records.append(record)
        current_id = None
        current_name = None
        sequence_parts = []

    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(">"):
            finish_record()
            header = line[1:].strip()
            if not header:
                raise ValueError(
                    f"FASTA record at line {line_number} has no identifier."
                )
            identifier, *description = header.split(maxsplit=1)
            current_id = identifier
            current_name = description[0] if description else None
            continue
        if current_id is None:
            raise ValueError(
                f"Alignment FASTA sequence data at line {line_number} has no header."
            )
        sequence_parts.append(line)
    finish_record()
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dnaforge jobs", description="Discover and control application-owned jobs."
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument(
        "--connection", type=Path, help="Explicit private runtime connection file"
    )
    selection.add_argument("--runtime", help="Registered runtime name or ID")
    commands = parser.add_subparsers(dest="command", required=True)
    serving = commands.add_parser(
        "serve", help="Run an explicitly configured managed runtime in the foreground"
    )
    serving.add_argument("name", help="Local runtime name")
    serving.add_argument(
        "runtime_config",
        type=Path,
        help="Annotation runtime JSON with explicit tool and data paths",
    )
    serving.add_argument(
        "--db", type=Path, help="Explicit local operation history path"
    )
    serving.add_argument(
        "--port", type=int, default=0, help="Loopback port; 0 selects an available port"
    )
    inventory = commands.add_parser(
        "runtimes", help="List locally registered runtimes without contacting them"
    )
    inventory.add_argument("--json", action="store_true")
    catalog = commands.add_parser(
        "catalog", help="Describe the connected runtime's supported operations"
    )
    catalog.add_argument("--json", action="store_true")
    submit = commands.add_parser(
        "submit",
        help="Submit any installed operation kind using its declared JSON request",
    )
    submit.add_argument("kind", help="Operation kind from the runtime catalog")
    submit.add_argument(
        "--request",
        required=True,
        help="Exact request JSON path, or '-' for standard input",
    )
    submit.add_argument("--json", action="store_true")
    import_recorded = commands.add_parser(
        "import-recorded",
        help="Import any installed operation kind using its declared receipt request",
    )
    import_recorded.add_argument("kind", help="Operation kind from the runtime catalog")
    import_recorded.add_argument(
        "--request",
        required=True,
        help="Exact recorded-import request JSON path, or '-' for standard input",
    )
    import_recorded.add_argument("--json", action="store_true")
    start = commands.add_parser(
        "start", help="Submit work to the selected managed runtime"
    )
    kinds = start.add_subparsers(dest="kind", required=True)
    annotation = kinds.add_parser(
        "annotation", help="Annotate one ordinary FASTA record"
    )
    annotation.add_argument("input", help="FASTA path, or '-' for standard input")
    annotation.add_argument(
        "--subject",
        help="Existing DNAForge document identity, if this input belongs to one",
    )
    annotation.add_argument(
        "--submission-key", help="Reuse only when retrying the exact same submission"
    )
    annotation.add_argument("--linear", action="store_true")
    annotation.add_argument("--start", type=int)
    annotation.add_argument("--end", type=int)
    annotation.add_argument("--json", action="store_true")
    alignment_index = kinds.add_parser(
        "alignment-index",
        aliases=["alignment-index-preparation"],
        help="Prepare an index for an ordinary local BAM file",
    )
    alignment_index.add_argument("input", help="Local BAM path")
    alignment_index.add_argument(
        "--submission-key", help="Reuse only when retrying the exact same submission"
    )
    alignment_index.add_argument("--json", action="store_true")
    variant_source = kinds.add_parser(
        "variant-source",
        aliases=["variant-source-preparation"],
        help="Prepare an ordinary local VCF or BCF file for indexed reading",
    )
    variant_source.add_argument("input", help="Local VCF or BCF path")
    variant_source.add_argument(
        "--reference",
        action="append",
        type=_parse_variant_reference,
        required=True,
        metavar="NAME:LENGTH",
        help="Expected reference name and length; repeat in display order",
    )
    variant_source.add_argument(
        "--submission-key", help="Reuse only when retrying the exact same submission"
    )
    variant_source.add_argument("--json", action="store_true")
    msa = kinds.add_parser(
        "msa",
        aliases=["multiple-sequence-alignment"],
        help="Align an ordinary multi-record protein FASTA file",
    )
    msa.add_argument(
        "input", help="Multi-record protein FASTA path, or '-' for standard input"
    )
    msa.add_argument(
        "--subject",
        help="Stable identity for this protein set; otherwise one is derived from the input",
    )
    msa.add_argument(
        "--submission-key", help="Reuse only when retrying the exact same submission"
    )
    msa.add_argument(
        "--algorithm",
        choices=[algorithm.value for algorithm in MsaAlgorithm],
        default=MsaAlgorithm.AUTO.value,
    )
    msa.add_argument("--threads", type=int, default=4)
    msa.add_argument("--timeout-seconds", type=int, default=MAX_MSA_TIMEOUT_SECONDS)
    msa.add_argument("--json", action="store_true")
    importing = commands.add_parser(
        "import-receipt",
        help="Retain a successful standalone run without executing it again",
    )
    import_kinds = importing.add_subparsers(dest="kind", required=True)
    import_annotation = import_kinds.add_parser(
        "annotation", help="Import one annotation receipt JSON file"
    )
    import_annotation.add_argument(
        "receipt", help="Receipt JSON path, or '-' for standard input"
    )
    import_annotation.add_argument(
        "--subject",
        help="Existing DNAForge document identity, if this run belongs to one",
    )
    import_annotation.add_argument("--json", action="store_true")
    inspecting = commands.add_parser(
        "inspect", help="Review retained results against a document"
    )
    inspect_kinds = inspecting.add_subparsers(dest="kind", required=True)
    inspect_annotation = inspect_kinds.add_parser("annotation")
    inspect_annotation.add_argument("operation_id")
    inspect_annotation.add_argument(
        "--document", required=True, help="Stable document identity"
    )
    inspect_annotation.add_argument("--json", action="store_true")
    applying = commands.add_parser(
        "apply", help="Save explicitly selected, reviewed results"
    )
    apply_kinds = applying.add_subparsers(dest="kind", required=True)
    apply_annotation = apply_kinds.add_parser("annotation")
    apply_annotation.add_argument(
        "inspection", help="Inspection JSON path, or '-' for standard input"
    )
    choices = apply_annotation.add_mutually_exclusive_group(required=True)
    choices.add_argument(
        "--candidate",
        action="append",
        help="Reviewed candidate ID; repeat for each choice",
    )
    choices.add_argument(
        "--all", action="store_true", help="Explicitly select every reviewed candidate"
    )
    apply_annotation.add_argument("--json", action="store_true")
    listing = commands.add_parser("list", help="List jobs in the connected scope")
    listing.add_argument("--subject", help="Filter by stable subject identity")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--offset", type=int, default=0)
    listing.add_argument("--json", action="store_true")
    for name in ("get", "stop", "result", "release-result"):
        command = commands.add_parser(name)
        command.add_argument("operation_id")
        command.add_argument("--json", action="store_true")
    actions = commands.add_parser(
        "actions", help="List authenticated operation action history"
    )
    actions.add_argument("operation_id")
    actions.add_argument("--limit", type=int, default=50)
    actions.add_argument("--offset", type=int, default=0)
    actions.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    attempted_apply_operation = None
    applied_response = None
    try:
        if args.command == "serve":
            from .managed_operations_server import serve

            return serve(
                args.name, args.runtime_config, db_path=args.db, port=args.port
            )
        if args.command == "runtimes":
            result = {
                "runtimes": [
                    {
                        "id": key,
                        "name": connection.scope_id,
                        "url": connection.url,
                        "owner": connection.owner_id,
                        "status": "registered",
                    }
                    for key, connection in registered_connections()
                ]
            }
            print(
                json.dumps(result, indent=None if args.json else 2, ensure_ascii=False)
            )
            return 0
        connection = resolve_connection(args.connection, args.runtime)
        client = ManagedOperationsClient(connection)
        if args.command == "catalog":
            result = client.request("GET", "/operations/catalog")
        elif args.command == "submit":
            if not _OPERATION_KIND_SLUG.fullmatch(args.kind):
                raise ValueError("Operation kind must be a safe lower-case slug.")
            result = client.request(
                "POST",
                f"/operations/{quote(args.kind, safe='')}",
                body=read_operation_request(args.request),
            )
        elif args.command == "import-recorded":
            if not _OPERATION_KIND_SLUG.fullmatch(args.kind):
                raise ValueError("Operation kind must be a safe lower-case slug.")
            result = client.request(
                "POST",
                f"/operations/{quote(args.kind, safe='')}/import-recorded",
                body=read_operation_request(args.request),
            )
        elif args.command == "start":
            if args.kind == "annotation":
                stream = (
                    nullcontext(sys.stdin)
                    if args.input == "-"
                    else Path(args.input).open("r", encoding="utf-8")
                )
                with stream as source:
                    fasta = read_single_fasta(source)
                request = AnnotationRequest(
                    sequence=fasta.sequence,
                    linear=args.linear,
                    start=args.start,
                    end=args.end,
                )
                operation_kind = "annotation"
                input_revision = annotation_input_revision(request)
            elif args.kind in {"msa", "multiple-sequence-alignment"}:
                request = MultipleSequenceAlignmentInput.model_validate(
                    {
                        "sequences": read_msa_fasta(args.input),
                        "algorithm": args.algorithm,
                        "threads": args.threads,
                        "timeout_seconds": args.timeout_seconds,
                    }
                )
                operation_kind = "multiple-sequence-alignment"
                input_revision = multiple_sequence_alignment_input_revision(request)
            elif args.kind in {
                "alignment-index",
                "alignment-index-preparation",
            }:
                request = AlignmentIndexRequest(
                    bamPath=str(Path(args.input).expanduser().resolve(strict=True))
                )
                operation_kind = "alignment-index-preparation"
                input_revision = None
            elif args.kind in {
                "variant-source",
                "variant-source-preparation",
            }:
                request = VariantSourceRequest(
                    variantPath=str(Path(args.input).expanduser().resolve(strict=True)),
                    references=args.reference,
                )
                operation_kind = "variant-source-preparation"
                input_revision = None
            else:
                raise ValueError(f"Unsupported jobs start kind: {args.kind}")
            subject = {"scope_id": connection.scope_id}
            if input_revision is not None:
                subject["subject_id"] = (
                    args.subject
                    or "external-input:" + input_revision.rsplit(":", 1)[-1]
                )
            submission_key = args.submission_key or str(uuid4())
            print(f"Submission key: {submission_key}", file=sys.stderr)
            result = client.request(
                "POST",
                f"/operations/{operation_kind}",
                body={
                    "submission_key": submission_key,
                    "subject": subject,
                    "input": request.model_dump(mode="json", by_alias=True),
                },
            )
        elif args.command == "import-receipt":
            receipt = read_receipt(args.receipt)
            subject_id = (
                args.subject
                or "recorded-input:" + receipt.input.revision.rsplit(":", 1)[-1]
            )
            result = client.request(
                "POST",
                "/operations/annotation/import-recorded",
                body={
                    "subject": {
                        "scope_id": connection.scope_id,
                        "subject_id": subject_id,
                    },
                    "receipt": receipt.model_dump(mode="json"),
                },
            )
        elif args.command == "inspect":
            target = AnnotationDocumentTarget(
                operationId=args.operation_id, targetDocumentId=args.document
            )
            response = client.request(
                "POST",
                "/operations/annotation/documents/inspect",
                body=target.model_dump(mode="json", by_alias=True),
            )
            try:
                inspection = AnnotationDocumentInspection.model_validate(response)
            except ValidationError as exc:
                raise ValueError(
                    "The runtime returned an invalid document inspection."
                ) from exc
            if (inspection.operation_id, inspection.target_document_id) != (
                target.operation_id,
                target.target_document_id,
            ):
                raise ValueError(
                    "The inspection belongs to a different operation or document."
                )
            result = inspection.model_dump(
                mode="json", by_alias=True, exclude_none=True
            )
        elif args.command == "apply":
            reviewed = read_annotation_document_selection(
                args.inspection, candidate_ids=args.candidate, all_candidates=args.all
            )
            attempted_apply_operation = reviewed.operation_id
            response = client.request(
                "POST",
                "/operations/annotation/documents/apply",
                body=reviewed.model_dump(mode="json", by_alias=True),
            )
            try:
                applied_response = AnnotationDocumentApplyResponse.model_validate(
                    response
                )
            except ValidationError as exc:
                raise ValueError(
                    "The runtime returned an invalid document outcome."
                ) from exc
            if (
                applied_response.outcome.status == "outcome-unresolved"
                and applied_response.outcome.action_id != applied_response.action_id
            ):
                raise ValueError(
                    "The document response contains inconsistent action identities."
                )
            result = applied_response.model_dump(
                mode="json", by_alias=True, exclude_none=True
            )
        elif args.command == "list":
            if not 1 <= args.limit <= 100 or args.offset < 0:
                raise ValueError(
                    "List limit must be 1–100 and offset must be nonnegative."
                )
            params = {
                "scope_id": connection.scope_id,
                "limit": args.limit,
                "offset": args.offset,
            }
            if args.subject:
                params["subject_id"] = args.subject
            result = client.request("GET", "/operations", params=params)
        elif args.command == "actions":
            if not 1 <= args.limit <= 100 or args.offset < 0:
                raise ValueError(
                    "Action limit must be 1–100 and offset must be nonnegative."
                )
            result = client.request(
                "GET",
                f"/operations/{quote(args.operation_id, safe='')}/actions",
                params={"limit": args.limit, "offset": args.offset},
            )
        else:
            path = f"/operations/{quote(args.operation_id, safe='')}"
            if args.command == "stop":
                result = client.request("POST", path + "/cancel", body={})
            elif args.command == "release-result":
                result = client.request("POST", path + "/release-result", body={})
            else:
                result = client.request(
                    "GET", path + ("/result" if args.command == "result" else "")
                )
        print(json.dumps(result, indent=None if args.json else 2, ensure_ascii=False))
        if applied_response is not None:
            return document_apply_exit_code(applied_response)
        if (
            args.command in {"stop", "release-result"}
            and isinstance(result, dict)
            and result.get("disposition") == "unavailable"
        ):
            reason = result.get("reason")
            print(
                (
                    reason
                    if isinstance(reason, str)
                    else "The requested operation action is unavailable."
                ),
                file=sys.stderr,
            )
            return 2
        return 0
    except (ValueError, OSError) as exc:
        print(f"dnaforge-jobs: {exc}", file=sys.stderr)
        if attempted_apply_operation is not None and not (
            isinstance(exc, ManagedOperationRequestError)
            and exc.code in DOCUMENT_ADMISSION_REFUSALS
        ):
            print(
                f"Apply may have been accepted. Read actions for operation {attempted_apply_operation} before repeating it.",
                file=sys.stderr,
            )
            return 3
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
