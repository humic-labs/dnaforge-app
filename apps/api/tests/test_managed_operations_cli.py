"""Real foreground CLI requests against a controlled HTTP boundary."""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from dnaforge_annotation.contract import AnnotationRequest
from dnaforge_annotation.identity import annotation_input_revision


def document_inspection(document_id="document-1"):
    feature = {
        "name": "Recorded candidate",
        "type": "misc_feature",
        "start": 1,
        "end": 4,
        "strand": 1,
        "identity": 100,
        "coverage": 100,
        "fragment": False,
        "ref_start": 1,
        "ref_end": 4,
        "ref_length": 4,
        "db_source": "nucleotide",
    }
    return {
        "operationId": "operation-1",
        "targetDocumentId": document_id,
        "operationVersion": 2,
        "resultSha256": "sha256:" + "a" * 64,
        "targetDocumentRevision": "annotation-document-v1:sha256:" + "b" * 64,
        "analyzedInputRevision": "input-1",
        "applicable": True,
        "coordinates": "exact",
        "transitionCount": 0,
        "candidates": [
            {
                "id": "operation-1:0",
                "index": 0,
                "sourceFeature": feature,
                "feature": feature,
                "substitutionOverlap": False,
            }
        ],
    }


@pytest.fixture
def runtime(tmp_path):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.command, self.path, dict(self.headers)))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if "/actions" in self.path:
                payload = {
                    "actions": [{"action": "import_recorded", "outcome": "imported"}],
                    "total": 1,
                    "next_offset": None,
                }
            else:
                payload = {
                    "operations": [{"id": "operation-1", "state": "running"}],
                    "total": 1,
                    "next_offset": None,
                }
            self.wfile.write(json.dumps(payload).encode())

        def do_POST(self):
            body = json.loads(
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
            )
            requests.append((self.command, self.path, dict(self.headers), body))
            if body.get("targetDocumentId") == "lost-response":
                self.close_connection = True
                return
            if body.get("targetDocumentId") == "no-native-owner":
                self.send_response(503)
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "detail": {
                                "code": "NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE",
                                "message": "No native document owner is connected to this runtime.",
                            }
                        }
                    ).encode()
                )
                return
            self.send_response(
                202
                if self.path
                in {
                    "/operations/alignment-index-preparation",
                    "/operations/annotation",
                    "/operations/multiple-sequence-alignment",
                    "/operations/primer-library-search",
                    "/operations/variant-source-preparation",
                }
                else 200
            )
            self.end_headers()
            if self.path in {
                "/operations/alignment-index-preparation",
                "/operations/annotation",
                "/operations/multiple-sequence-alignment",
                "/operations/primer-library-search",
                "/operations/variant-source-preparation",
            }:
                self.wfile.write(b'{"id":"operation-1","state":"queued"}')
            elif self.path == "/operations/annotation/import-recorded":
                self.wfile.write(
                    b'{"id":"recorded-1","state":"succeeded","origin":"recorded"}'
                )
            elif self.path == "/operations/report/import-recorded":
                self.wfile.write(
                    b'{"id":"report-1","state":"succeeded","origin":"recorded"}'
                )
            elif self.path == "/operations/annotation/documents/inspect":
                self.wfile.write(json.dumps(document_inspection()).encode())
            elif self.path == "/operations/annotation/documents/apply":
                document_id = body["targetDocumentId"]
                outcome = {
                    "status": "saved",
                    "targetDocumentRevision": "saved-revision",
                    "checkpoint": {"status": "committed", "commit": "c" * 40},
                    "display": "not-required",
                }
                if document_id == "blocked-doc":
                    outcome = {
                        "status": "blocked",
                        "reason": "The reviewed document changed.",
                    }
                if document_id == "unresolved-doc":
                    outcome = {
                        "status": "outcome-unresolved",
                        "reason": "The file outcome is unconfirmed.",
                        "actionId": "action-1",
                    }
                if document_id == "checkpoint-failed":
                    outcome["checkpoint"] = {
                        "status": "failed",
                        "reason": "The checkpoint could not be written.",
                    }
                self.wfile.write(
                    json.dumps({"actionId": "action-1", "outcome": outcome}).encode()
                )
            elif "unavailable" in self.path:
                self.wfile.write(
                    b'{"snapshot":{"id":"operation-unavailable","state":"running"},"disposition":"unavailable","reason":"Action is unavailable"}'
                )
            elif self.path.endswith("/release-result"):
                self.wfile.write(
                    b'{"snapshot":{"id":"operation-1","result_status":"released"},"disposition":"released","reason":"Result released"}'
                )
            else:
                self.wfile.write(
                    b'{"snapshot":{"id":"operation-1","state":"stopping"},"disposition":"accepted","reason":"Stop requested"}'
                )

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = tmp_path / "runtime.json"
    connection.write_text(
        json.dumps(
            {
                "version": 1,
                "url": f"http://127.0.0.1:{server.server_port}",
                "session_token": "test-session",
                "operation_token": "test-human-authority",
                "scope_id": "test-scope",
                "owner_id": "local-human",
            }
        )
    )
    connection.chmod(0o600)
    yield connection, requests
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def cli(connection: Path, *args, input=None):
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "src.managed_operations_cli",
            "--connection",
            str(connection),
            *args,
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        input=input,
        timeout=10,
    )


def test_cli_inspects_the_native_document_without_applying_or_running_computation(
    runtime,
):
    connection, requests = runtime
    completed = cli(
        connection,
        "inspect",
        "annotation",
        "operation-1",
        "--document",
        "document-1",
        "--json",
    )
    assert completed.returncode == 0, completed.stderr
    inspected = json.loads(completed.stdout)
    assert inspected["candidates"][0]["id"] == "operation-1:0"
    assert requests[0][0:2] == ("POST", "/operations/annotation/documents/inspect")
    assert requests[0][3] == {
        "operationId": "operation-1",
        "targetDocumentId": "document-1",
    }
    assert len(requests) == 1


@pytest.mark.parametrize("all_candidates", [False, True])
def test_cli_applies_the_explicit_selection_from_reviewed_json_without_refreshing_it(
    runtime, all_candidates
):
    connection, requests = runtime
    reviewed = document_inspection()
    flags = ["--all"] if all_candidates else ["--candidate", "operation-1:0"]
    completed = cli(
        connection,
        "apply",
        "annotation",
        "-",
        *flags,
        "--json",
        input=json.dumps(reviewed),
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["actionId"] == "action-1"
    assert requests[0][0:2] == ("POST", "/operations/annotation/documents/apply")
    headers, body = requests[0][2:4]
    assert headers["X-DNAForge-Operation-Channel"] == "managed_cli"
    assert body == {
        "operationId": "operation-1",
        "targetDocumentId": "document-1",
        "expectedOperationVersion": reviewed["operationVersion"],
        "expectedResultSha256": reviewed["resultSha256"],
        "expectedTargetDocumentRevision": reviewed["targetDocumentRevision"],
        "selectedCandidateIds": ["operation-1:0"],
    }
    assert len(requests) == 1
    assert "test-human-authority" not in completed.stdout + completed.stderr


@pytest.mark.parametrize(
    "change",
    [
        "missing-choice",
        "unknown-candidate",
        "duplicate-candidate",
        "not-applicable",
        "invalid",
    ],
)
def test_cli_refuses_missing_or_invalid_review_choices_before_dispatch(runtime, change):
    connection, requests = runtime
    reviewed = document_inspection()
    flags = ["--candidate", "operation-1:0"]
    if change == "missing-choice":
        flags = []
    if change == "unknown-candidate":
        flags = ["--candidate", "operation-1:99"]
    if change == "duplicate-candidate":
        flags *= 2
    if change == "not-applicable":
        reviewed.update(applicable=False, blockReason="The sequence changed.")
    if change == "invalid":
        reviewed["resultSha256"] = "wrong"
    completed = cli(
        connection,
        "apply",
        "annotation",
        "-",
        *flags,
        "--json",
        input=json.dumps(reviewed),
    )
    assert completed.returncode != 0
    assert requests == []


@pytest.mark.parametrize(
    "document_id,exit_code",
    [("blocked-doc", 2), ("unresolved-doc", 3), ("checkpoint-failed", 2)],
)
def test_cli_keeps_the_action_receipt_and_returns_a_distinct_unsuccessful_exit(
    runtime, tmp_path, document_id, exit_code
):
    connection, requests = runtime
    inspection = tmp_path / "review.json"
    inspection.write_text(json.dumps(document_inspection(document_id)))
    completed = cli(
        connection, "apply", "annotation", str(inspection), "--all", "--json"
    )
    assert completed.returncode == exit_code, completed.stderr
    assert json.loads(completed.stdout)["actionId"] == "action-1"
    assert "action-1" in completed.stderr
    assert len(requests) == 1


def test_cli_lost_apply_response_directs_observation_of_existing_history_without_retry(
    runtime,
):
    connection, requests = runtime
    completed = cli(
        connection,
        "apply",
        "annotation",
        "-",
        "--all",
        "--json",
        input=json.dumps(document_inspection("lost-response")),
    )
    assert completed.returncode == 3
    assert "operation-1" in completed.stderr
    assert "before repeating" in completed.stderr
    assert len(requests) == 1


def test_cli_does_not_describe_an_explicit_preadmission_refusal_as_an_unknown_save(
    runtime,
):
    connection, requests = runtime
    completed = cli(
        connection,
        "apply",
        "annotation",
        "-",
        "--all",
        "--json",
        input=json.dumps(document_inspection("no-native-owner")),
    )
    assert completed.returncode == 1
    assert "No native document owner" in completed.stderr
    assert "may have been accepted" not in completed.stderr
    assert len(requests) == 1


def test_cli_lists_the_shared_scope_with_human_authority(runtime):
    connection, requests = runtime
    completed = cli(connection, "list", "--json")
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["operations"][0]["id"] == "operation-1"
    assert json.loads(completed.stdout)["total"] == 1
    assert json.loads(completed.stdout)["next_offset"] is None
    assert len(requests) == 1
    method, path, headers = requests[0]
    assert method == "GET"
    assert path.startswith("/operations?") and "scope_id=test-scope" in path
    assert headers["X-DNAForge-Session"] == "test-session"
    assert headers["X-DNAForge-Operation-Authority"] == "test-human-authority"
    assert headers["X-DNAForge-Operation-Channel"] == "managed_cli"
    assert "test-human-authority" not in completed.stdout + completed.stderr


def test_cli_submits_the_primer_library_search_contract(runtime):
    connection, requests = runtime
    body = {
        "submission_key": "primer-search-request-1",
        "subject": {"scope_id": "test-scope"},
        "input": {
            "targetDocumentId": "document-a",
            "referenceSequence": "target-one",
            "circular": False,
            "primers": [
                {
                    "id": "primer-a",
                    "sequence": "primer-one",
                    "revision": "updated-at:1",
                }
            ],
            "maxEditDistance": 3,
            "minMatchLength": 0,
            "minEffectiveTm": 0,
            "maxMismatches": 3,
        },
    }

    completed = cli(
        connection,
        "submit",
        "primer-library-search",
        "--request",
        "-",
        "--json",
        input=json.dumps(body),
    )

    assert completed.returncode == 0, completed.stderr
    assert requests == [
        (
            "POST",
            "/operations/primer-library-search",
            requests[0][2],
            body,
        )
    ]
    assert requests[0][2]["X-DNAForge-Operation-Channel"] == "managed_cli"


@pytest.mark.parametrize("request_source", ["file", "stdin"])
def test_cli_submits_any_registered_kind_with_its_exact_json_contract(
    runtime, tmp_path, request_source
):
    connection, requests = runtime
    body = {
        "submission_key": "report-request-1",
        "scope_id": "test-scope",
        "subject_id": "sample-report",
        "input": {"text": "ordinary external workflow output"},
    }
    request_path = tmp_path / "report-request.json"
    request_path.write_text(json.dumps(body))

    completed = cli(
        connection,
        "submit",
        "report",
        "--request",
        "-" if request_source == "stdin" else str(request_path),
        "--json",
        input=json.dumps(body) if request_source == "stdin" else None,
    )

    assert completed.returncode == 0, completed.stderr
    assert requests == [
        (
            "POST",
            "/operations/report",
            requests[0][2],
            body,
        )
    ]
    assert requests[0][2]["X-DNAForge-Operation-Channel"] == "managed_cli"


@pytest.mark.parametrize("request_source", ["file", "stdin"])
def test_cli_imports_any_registered_kind_with_its_exact_receipt_contract(
    runtime, tmp_path, request_source
):
    connection, requests = runtime
    body = {
        "run_id": "report-run-1",
        "scope_id": "test-scope",
        "subject_id": "sample-report",
        "result": {"normalized": "ordinary external workflow output"},
    }
    request_path = tmp_path / "report-receipt.json"
    request_path.write_text(json.dumps(body))

    completed = cli(
        connection,
        "import-recorded",
        "report",
        "--request",
        "-" if request_source == "stdin" else str(request_path),
        "--json",
        input=json.dumps(body) if request_source == "stdin" else None,
    )

    assert completed.returncode == 0, completed.stderr
    assert requests == [
        (
            "POST",
            "/operations/report/import-recorded",
            requests[0][2],
            body,
        )
    ]
    assert requests[0][2]["X-DNAForge-Operation-Channel"] == "managed_cli"


def test_cli_stop_reports_stopping_without_claiming_cancellation_complete(runtime):
    connection, requests = runtime
    completed = cli(connection, "stop", "operation-1", "--json")
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["snapshot"]["state"] == "stopping"
    assert json.loads(completed.stdout)["disposition"] == "accepted"
    assert requests[0][0:2] == ("POST", "/operations/operation-1/cancel")


def test_cli_can_explicitly_release_a_retained_result(runtime):
    connection, requests = runtime
    completed = cli(connection, "release-result", "operation-1", "--json")
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["disposition"] == "released"
    assert requests[0][0:2] == ("POST", "/operations/operation-1/release-result")


def test_cli_imports_a_success_receipt_and_lists_action_history(runtime, tmp_path):
    connection, requests = runtime
    receipt = tmp_path / "receipt.json"
    request = AnnotationRequest(sequence="ACGT")
    receipt.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "0199305d-5d20-7000-8000-000000000001",
                "tool": {"name": "dnaforge-annotation", "version": "0.1.0"},
                "outcome": "succeeded",
                "started_at": "2026-09-09T12:00:00+00:00",
                "finished_at": "2026-09-09T12:01:00+00:00",
                "input": {
                    "path": "-",
                    "sequence_id": "sample",
                    "sequence_length": 4,
                    "revision": annotation_input_revision(request),
                },
                "output": {"format": "json", "path": "-"},
                "request": request.model_dump(mode="json"),
                "runtime": {
                    "data_dir": "/data",
                    "executables": {
                        "blastn": "/blastn",
                        "diamond": "/diamond",
                        "cmscan": "/cmscan",
                    },
                    "temp_dir": None,
                    "threads": 1,
                    "database_config": None,
                },
                "reference_data": {"manifest": "/databases.yml", "versions": {}},
                "result": {"features": [], "sequence_length": 4, "error": None},
            }
        )
    )
    completed = cli(
        connection,
        "import-receipt",
        "annotation",
        str(receipt),
        "--subject",
        "sequence-a",
        "--json",
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["origin"] == "recorded"
    method, path, _headers, body = requests[0]
    assert (method, path) == ("POST", "/operations/annotation/import-recorded")
    assert body["subject"] == {"scope_id": "test-scope", "subject_id": "sequence-a"}
    assert body["receipt"]["request"]["sequence"] == "ACGT"
    assert "actor_id" not in body

    actions = cli(connection, "actions", "recorded-1", "--limit", "10", "--json")
    assert actions.returncode == 0, actions.stderr
    assert json.loads(actions.stdout)["actions"][0]["outcome"] == "imported"
    assert requests[1][0] == "GET"
    assert requests[1][1].startswith("/operations/recorded-1/actions?")


@pytest.mark.parametrize("command", ["stop", "release-result"])
def test_cli_returns_failure_when_requested_action_is_unavailable(runtime, command):
    connection, _requests = runtime
    completed = cli(connection, command, "operation-unavailable", "--json")
    assert completed.returncode != 0
    assert json.loads(completed.stdout)["disposition"] == "unavailable"
    assert "Action is unavailable" in completed.stderr


@pytest.mark.skipif(os.name == "nt", reason="POSIX file-mode boundary")
def test_cli_rejects_a_connection_file_readable_by_other_users(runtime):
    connection, requests = runtime
    connection.chmod(0o644)
    completed = cli(connection, "list", "--json")
    assert completed.returncode != 0
    assert "permissions" in completed.stderr
    assert requests == []


def test_cli_refuses_non_loopback_authority_without_a_request(runtime):
    connection, requests = runtime
    settings = json.loads(connection.read_text())
    settings["url"] = "https://example.org"
    connection.write_text(json.dumps(settings))
    completed = cli(connection, "list", "--json")
    assert completed.returncode != 0
    assert "loopback" in completed.stderr
    assert requests == []


def test_cli_missing_runtime_is_an_explicit_error_not_an_implicit_daemon(tmp_path):
    completed = cli(tmp_path / "absent.json", "list", "--json")
    assert completed.returncode != 0
    assert completed.stdout == ""
    assert "connection" in completed.stderr.lower()
    assert not list(tmp_path.iterdir())


def _discovery_cli(directory, *args):
    env = dict(os.environ, DNAFORGE_OPERATION_RUNTIME_DIR=str(directory))
    env.pop("DNAFORGE_OPERATION_CONNECTION_FILE", None)
    return subprocess.run(
        [sys.executable, "-m", "src.managed_operations_cli", *args],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )


def _register_runtime(directory, connection, scope):
    directory.mkdir(mode=0o700, exist_ok=True)
    target = directory / f"{scope}.connection.json"
    body = json.loads(connection.read_text())
    target.write_text(json.dumps(dict(body, scope_id=scope)))
    target.chmod(0o600)


def test_cli_finds_one_registered_runtime_without_internal_file_argument(
    runtime, tmp_path
):
    connection, requests = runtime
    directory = tmp_path / "runtimes"
    _register_runtime(directory, connection, "lab")
    completed = _discovery_cli(directory, "list", "--json")
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["operations"][0]["id"] == "operation-1"
    assert len(requests) == 1
    assert "test-human-authority" not in completed.stdout + completed.stderr


def test_cli_requires_runtime_selection_when_several_are_registered(runtime, tmp_path):
    connection, requests = runtime
    directory = tmp_path / "runtimes"
    for scope in ("lab-a", "lab-b"):
        _register_runtime(directory, connection, scope)
    completed = _discovery_cli(directory, "list", "--json")
    assert completed.returncode != 0
    assert "--runtime" in completed.stderr
    assert "lab-a (lab-a)" in completed.stderr and "lab-b (lab-b)" in completed.stderr
    assert requests == []
    selected = _discovery_cli(directory, "--runtime", "lab-b", "list", "--json")
    assert selected.returncode == 0, selected.stderr
    assert "scope_id=lab-b" in requests[0][1]


def test_dead_registrations_do_not_block_discovery(runtime, tmp_path):
    connection, requests = runtime
    directory = tmp_path / "runtimes"
    exited = subprocess.Popen([sys.executable, "-c", "pass"])
    exited.wait()
    body = json.loads(connection.read_text())
    directory.mkdir(mode=0o700)
    for index in range(80):
        stale = directory / f"crashed-{index}.connection.json"
        stale.write_text(
            json.dumps(dict(body, scope_id=f"old-{index}", pid=exited.pid))
        )
        stale.chmod(0o600)
    _register_runtime(directory, connection, "lab")
    completed = _discovery_cli(directory, "runtimes", "--json")
    assert completed.returncode == 0, completed.stderr
    assert [item["name"] for item in json.loads(completed.stdout)["runtimes"]] == [
        "lab"
    ]
    assert sorted(path.name for path in directory.iterdir()) == ["lab.connection.json"]
    listed = _discovery_cli(directory, "list", "--json")
    assert listed.returncode == 0, listed.stderr
    assert len(requests) == 1


def test_cli_runtime_inventory_has_no_network_or_secret_output(runtime, tmp_path):
    connection, requests = runtime
    directory = tmp_path / "runtimes"
    _register_runtime(directory, connection, "lab")
    completed = _discovery_cli(directory, "runtimes", "--json")
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["runtimes"][0]["name"] == "lab"
    assert requests == []
    assert "test-human-authority" not in completed.stdout + completed.stderr
    assert "test-session" not in completed.stdout + completed.stderr


def test_cli_submits_ordinary_fasta_with_an_explicit_retry_identity(runtime, tmp_path):
    connection, requests = runtime
    source = tmp_path / "sample.fasta"
    source.write_text(">sample\nACGT\n")
    completed = cli(
        connection,
        "start",
        "annotation",
        str(source),
        "--subject",
        "sequence-a",
        "--submission-key",
        "request-a",
        "--json",
    )
    assert completed.returncode == 0, completed.stderr
    assert requests[0][0:2] == ("POST", "/operations/annotation")
    body = requests[0][3]
    assert body["submission_key"] == "request-a"
    assert body["subject"] == {"scope_id": "test-scope", "subject_id": "sequence-a"}
    assert body["input"] == {
        "sequence": "ACGT",
        "linear": False,
        "start": None,
        "end": None,
    }
    assert "actor_id" not in body


def test_cli_starts_alignment_index_from_an_ordinary_bam_path(runtime, tmp_path):
    connection, requests = runtime
    source = tmp_path / "sample.bam"
    source.write_bytes(b"bam-placeholder")

    completed = cli(
        connection,
        "start",
        "alignment-index",
        str(source),
        "--submission-key",
        "index-request-a",
        "--json",
    )

    assert completed.returncode == 0, completed.stderr
    assert requests[0][0:2] == (
        "POST",
        "/operations/alignment-index-preparation",
    )
    assert requests[0][3] == {
        "submission_key": "index-request-a",
        "subject": {"scope_id": "test-scope"},
        "input": {"bamPath": str(source.resolve(strict=True))},
    }


def test_cli_starts_variant_source_from_an_ordinary_vcf_path(runtime, tmp_path):
    connection, requests = runtime
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-placeholder")

    completed = cli(
        connection,
        "start",
        "variant-source",
        str(source),
        "--reference",
        "chr1:248956422",
        "--reference",
        "chr2:242193529",
        "--submission-key",
        "variant-request-a",
        "--json",
    )

    assert completed.returncode == 0, completed.stderr
    assert requests[0][0:2] == (
        "POST",
        "/operations/variant-source-preparation",
    )
    assert requests[0][3] == {
        "submission_key": "variant-request-a",
        "subject": {"scope_id": "test-scope"},
        "input": {
            "variantPath": str(source.resolve(strict=True)),
            "references": [
                {"name": "chr1", "length": 248_956_422},
                {"name": "chr2", "length": 242_193_529},
            ],
        },
    }


@pytest.mark.parametrize(
    "reference",
    ["chr1", "chr1:not-a-length", ":100", "chr 1:100", "chr1:0"],
)
def test_cli_rejects_an_invalid_variant_reference_before_submission(
    runtime, tmp_path, reference
):
    connection, requests = runtime
    source = tmp_path / "calls.vcf"
    source.write_bytes(b"variant-placeholder")

    completed = cli(
        connection,
        "start",
        "variant-source",
        str(source),
        "--reference",
        reference,
        "--json",
    )

    assert completed.returncode != 0
    assert "NAME:LENGTH" in completed.stderr
    assert requests == []


@pytest.mark.parametrize("input_source", ["file", "stdin"])
def test_cli_starts_managed_msa_from_ordinary_multi_record_fasta(
    runtime, tmp_path, input_source
):
    connection, requests = runtime
    fasta = (
        ">protein-a First protein\nMKTIIALSYI\n>protein-b Second protein\nMKTIVALSYI\n"
    )
    source = tmp_path / "proteins.fasta"
    source.write_text(fasta)

    completed = cli(
        connection,
        "start",
        "msa",
        "-" if input_source == "stdin" else str(source),
        "--subject",
        "protein-set-a",
        "--submission-key",
        "msa-request-a",
        "--algorithm",
        "fast",
        "--threads",
        "2",
        "--timeout-seconds",
        "90",
        "--json",
        input=fasta if input_source == "stdin" else None,
    )

    assert completed.returncode == 0, completed.stderr
    assert requests[0][0:2] == (
        "POST",
        "/operations/multiple-sequence-alignment",
    )
    assert requests[0][3] == {
        "submission_key": "msa-request-a",
        "subject": {
            "scope_id": "test-scope",
            "subject_id": "protein-set-a",
        },
        "input": {
            "sequences": [
                {
                    "id": "protein-a",
                    "name": "First protein",
                    "sequence": "MKTIIALSYI",
                },
                {
                    "id": "protein-b",
                    "name": "Second protein",
                    "sequence": "MKTIVALSYI",
                },
            ],
            "algorithm": "fast",
            "threads": 2,
            "timeout_seconds": 90,
        },
    }


def test_cli_refuses_invalid_multi_record_fasta_before_msa_submission(
    runtime, tmp_path
):
    connection, requests = runtime
    source = tmp_path / "proteins.fasta"
    source.write_text(">only-one\nMKTIIALSYI\n")

    completed = cli(connection, "start", "msa", str(source), "--json")

    assert completed.returncode != 0
    assert "at least 2" in completed.stderr
    assert requests == []


def test_cli_refuses_invalid_fasta_before_submission(runtime, tmp_path):
    connection, requests = runtime
    source = tmp_path / "sample.fasta"
    source.write_text(">sample-a\nACGT\n>sample-b\nACGT\n")
    completed = cli(connection, "start", "annotation", str(source), "--json")
    assert completed.returncode != 0
    assert "FASTA input must contain exactly one record" in completed.stderr
    assert requests == []
