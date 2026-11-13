"""Foreground command-line interface for ordinary annotation files."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, TextIO

from pydantic import ValidationError

from .contract import AnnotationExecutables, AnnotationRequest, AnnotationRuntime
from .core import run_annotation
from .files import FastaFormatError, read_single_fasta, write_gff3
from .receipt import create_receipt, display_path

_WINDOWS_EXECUTABLE_SUFFIXES = (".exe", ".bat", ".cmd", ".com")


def _tool_path(tools_dir: Path, name: str, *, windows: bool | None = None) -> Path:
    base = tools_dir / name
    if windows is None:
        windows = os.name == "nt"
    if windows:
        for suffix in _WINDOWS_EXECUTABLE_SUFFIXES:
            candidate = Path(str(base) + suffix)
            if candidate.is_file():
                return candidate
    return base


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dnaforge-annotate",
        description="Annotate one FASTA record in the foreground.",
    )
    parser.add_argument("input", help="FASTA path, or '-' for standard input")
    parser.add_argument("--output", "-o", default="-", help="Output path or '-'")
    parser.add_argument(
        "--format", choices=("gff3", "json"), default="gff3", help="Output format"
    )
    parser.add_argument("--receipt", help="Optional portable JSON receipt path")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--tools-dir", type=Path, required=True)
    parser.add_argument("--temp-dir", type=Path)
    parser.add_argument("--database-config", type=Path)
    parser.add_argument("--threads", type=_positive_int, default=1)
    parser.add_argument("--linear", action="store_true")
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    return parser


@contextmanager
def _input_stream(path: str) -> Iterator[TextIO]:
    if path == "-":
        yield sys.stdin
        return
    with Path(path).open("r", encoding="utf-8") as source:
        yield source


def _write_output(path: str, writer) -> None:
    if path == "-":
        writer(sys.stdout)
        return
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent, text=True
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            writer(stream)
        os.replace(temporary_name, destination)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


@contextmanager
def _foreground_signals() -> Iterator[None]:
    previous = signal.getsignal(signal.SIGTERM)

    def interrupt(_signum, _frame) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def main(argv: list[str] | None = None) -> int:
    """Run one foreground annotation and return a process exit status."""
    args = _parser().parse_args(argv)
    started_at = datetime.now(timezone.utc)

    try:
        with _input_stream(args.input) as source:
            fasta = read_single_fasta(source)
    except (FastaFormatError, OSError) as exc:
        print(f"dnaforge-annotate: {exc}", file=sys.stderr)
        return 2

    runtime = AnnotationRuntime(
        data_dir=args.data_dir,
        executables=AnnotationExecutables(
            blastn=_tool_path(args.tools_dir, "blastn"),
            diamond=_tool_path(args.tools_dir, "diamond"),
            cmscan=_tool_path(args.tools_dir, "cmscan"),
        ),
        temp_dir=args.temp_dir,
        threads=args.threads,
        database_config=args.database_config,
    )
    request = AnnotationRequest(
        sequence=fasta.sequence,
        linear=args.linear,
        start=args.start,
        end=args.end,
    )

    try:
        with _foreground_signals():
            result = run_annotation(request, runtime)
    except KeyboardInterrupt:
        print("dnaforge-annotate: interrupted", file=sys.stderr)
        return 130
    except FileNotFoundError as exc:
        print(f"dnaforge-annotate: missing dependency: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"dnaforge-annotate: annotation failed: {exc}", file=sys.stderr)
        return 1

    try:
        if args.format == "json":
            _write_output(
                args.output,
                lambda destination: destination.write(
                    result.model_dump_json(indent=2) + "\n"
                ),
            )
        else:
            _write_output(
                args.output,
                lambda destination: write_gff3(
                    result, sequence_id=fasta.identifier, destination=destination
                ),
            )

        if args.receipt:
            receipt = create_receipt(
                request=request,
                result=result,
                runtime=runtime,
                input_path=display_path(args.input),
                sequence_id=fasta.identifier,
                output_path=display_path(args.output),
                output_format=args.format,
                started_at=started_at,
            )
            _write_output(
                args.receipt,
                lambda destination: destination.write(
                    json.dumps(receipt, indent=2, sort_keys=True) + "\n"
                ),
            )
    except OSError as exc:
        print(f"dnaforge-annotate: could not write output: {exc}", file=sys.stderr)
        return 4
    except ValidationError:
        print(
            "dnaforge-annotate: could not create a consistent run receipt",
            file=sys.stderr,
        )
        return 4
    return 0
