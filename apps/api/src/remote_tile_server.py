"""User-started, loopback-only genomic computation beside one indexed source.

Uses the existing alignment/coverage services. OpenSSH remains the transport;
the private receipt holds per-process HTTP authority, never SSH credentials.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import secrets
import signal
import stat
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
)

from .aligned_read_file_generation import capture_aligned_read_file_generation
from .services import alignment_tiles, pileup
from .services import tile_geometry as geometry
from .services.dna_coverage_shellout import (
    coverage_engine_identity,
    find_dna_coverage_binary,
)

CONTRACT = "dnaforge-remote-tiles.v1"
MAX_BODY_BYTES = 1024 * 1024


class _Segment(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    chrom: str = Field(min_length=1, max_length=256)
    start: StrictInt = Field(ge=0)
    end: StrictInt = Field(ge=0)
    chrom_global_start: StrictInt = Field(0, alias="chromGlobalStart", ge=0)


class _SourceBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    bam_path: str = Field(alias="bamPath", min_length=1, max_length=4096)
    index_path: str | None = Field(None, alias="indexPath", max_length=4096)
    reference_path: str | None = Field(None, alias="referencePath", max_length=4096)
    source_generation: dict | None = Field(None, alias="sourceGeneration")


class _TileBody(_SourceBody):
    chrom: str | None = Field(None, max_length=256)
    chrom_global_start: StrictInt = Field(0, alias="chromGlobalStart", ge=0)
    guides_only: StrictBool = Field(False, alias="guidesOnly")
    segments: list[_Segment] | None = Field(None, max_length=1000)


class _ReadBody(_SourceBody):
    chrom: str = Field(min_length=1, max_length=256)
    read_id: str = Field(alias="readId", min_length=1, max_length=1024)
    reference_start: StrictInt = Field(alias="referenceStart", ge=0, le=2**53 - 1)
    flag: StrictInt = Field(ge=0, le=65535)
    read_number: StrictInt | None = Field(None, alias="readNumber", ge=1, le=2)


class RemoteTileServer:
    def __init__(
        self,
        alignment_path: str | Path,
        index_path: str | Path,
        *,
        receipt_path: Path,
        reference_path: str | Path | None = None,
        concurrency: int = 4,
    ) -> None:
        find_dna_coverage_binary()
        self.alignment = str(Path(alignment_path).resolve(strict=True))
        self.index = str(Path(index_path).resolve(strict=True))
        self.reference = (
            str(Path(reference_path).resolve(strict=True)) if reference_path else None
        )
        self.receipt_path = receipt_path
        self.pid = os.getpid()
        self._slots = threading.BoundedSemaphore(concurrency)
        self._admitted = threading.BoundedSemaphore(concurrency + 16)
        self._thread: threading.Thread | None = None
        self._receipt_identity: tuple[int, int] | None = None

        def capture(path: str) -> dict:
            return capture_aligned_read_file_generation(path).model_dump(
                mode="json", by_alias=True, exclude_none=False
            )

        self.generation = {
            "contract": "aligned-read-source-generation.v1",
            "alignment": capture(self.alignment),
            "index": capture(self.index),
            **(
                {
                    "reference": capture(self.reference),
                    "referenceIndex": capture(self.reference + ".fai"),
                }
                if self.reference
                else {}
            ),
        }
        self.header = pileup.read_alignment_header(
            self.alignment, self.index, reference_fasta=self.reference
        )
        if self.header["index"]["state"] != "present":
            raise pileup.IndexNotFoundError(
                "The selected alignment has no usable index."
            )
        self.lengths = {
            item["name"]: item["length"] for item in self.header["references"]
        }
        self._require_generation()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self):
                super().setup()
                self.connection.settimeout(15)

            def log_message(self, *_args):
                pass

            def respond(self, status: int, payload: object) -> None:
                data = json.dumps(
                    payload, separators=(",", ":"), allow_nan=False
                ).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.send_header("X-DNAForge-Compute-Pid", str(owner.pid))
                self.send_header("X-DNAForge-Compute-Platform", platform.system())
                self.end_headers()
                self.close_connection = True
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def authorized(self) -> bool:
                values = self.headers.get_all("X-DNAForge-Session", [])
                return len(values) == 1 and secrets.compare_digest(
                    values[0], owner.receipt["sessionToken"]
                )

            def do_GET(self) -> None:
                if not self.authorized():
                    return self.respond(401, {"error": "SESSION_REQUIRED"})
                if self.path != "/v1/capabilities":
                    return self.respond(404, {"error": "ROUTE_NOT_FOUND"})
                try:
                    owner._require_generation()
                    self.respond(200, owner.capabilities())
                except pileup.SourceGenerationChangedError:
                    self.respond(409, {"error": "SOURCE_GENERATION_CHANGED"})

            def do_POST(self) -> None:
                if not self.authorized():
                    return self.respond(401, {"error": "SESSION_REQUIRED"})
                route = re.fullmatch(
                    r"/tiles/(alignment|coverage|coverage-assembly)/(\d+)/(\d+)",
                    self.path,
                )
                is_read = self.path == "/tiles/alignment/read"
                is_header = self.path == "/tiles/alignment/header"
                if not route and not is_read and not is_header:
                    return self.respond(404, {"error": "ROUTE_NOT_FOUND"})
                if not owner._admitted.acquire(blocking=False):
                    return self.respond(429, {"error": "TILE_QUEUE_FULL"})
                acquired = False
                try:
                    acquired = owner._slots.acquire(timeout=5)
                    if not acquired:
                        return self.respond(429, {"error": "TILE_QUEUE_FULL"})
                    lengths = self.headers.get_all("Content-Length", [])
                    if len(lengths) != 1 or self.headers.get("Transfer-Encoding"):
                        raise ValueError("A single bounded content length is required.")
                    length = int(lengths[0])
                    if not 0 < length <= MAX_BODY_BYTES:
                        raise ValueError("Tile request is too large.")
                    data = self.rfile.read(length)
                    if len(data) != length:
                        raise ValueError("The tile request ended early.")
                    body = (
                        _ReadBody.model_validate_json(data)
                        if is_read
                        else (
                            _SourceBody.model_validate_json(data)
                            if is_header
                            else _TileBody.model_validate_json(data)
                        )
                    )
                    owner._require_source(body)
                    owner._require_generation()
                    if is_header:
                        result = owner.header
                    elif isinstance(body, _ReadBody):
                        if (
                            body.chrom not in owner.lengths
                            or body.reference_start >= owner.lengths[body.chrom]
                        ):
                            raise ValueError(
                                "The read coordinates are outside the source."
                            )
                        result = alignment_tiles.read_single_read_metadata(
                            owner.alignment,
                            body.chrom,
                            read_id=body.read_id,
                            reference_start=body.reference_start,
                            flag=body.flag,
                            read_number=body.read_number,
                            index_path=owner.index,
                            reference_fasta=owner.reference,
                        )
                    else:
                        level, index = int(route[2]), int(route[3])
                        if level > 32 or index > 2**53 - 1:
                            raise ValueError(
                                "Tile coordinates are outside the supported geometry."
                            )
                        result = owner.calculate(route[1], level, index, body)
                    owner._require_generation()
                    self.respond(200, result)
                except pileup.SourceGenerationChangedError:
                    self.respond(409, {"error": "SOURCE_GENERATION_CHANGED"})
                except (ValueError, ValidationError, KeyError):
                    self.respond(422, {"error": "INVALID_TILE_REQUEST"})
                except (
                    pileup.BamNotFoundError,
                    pileup.IndexNotFoundError,
                    pileup.ReferenceNotFoundError,
                    alignment_tiles.ReadNotFoundError,
                ) as error:
                    self.respond(
                        404, {"error": "SOURCE_UNAVAILABLE", "detail": str(error)}
                    )
                except Exception as error:
                    if type(error).__name__ == "CoveragePyramidMissingError":
                        self.respond(425, {"error": "COVERAGE_NOT_PREPARED"})
                    else:
                        self.respond(500, {"error": "TILE_CALCULATION_FAILED"})
                finally:
                    if acquired:
                        owner._slots.release()
                    owner._admitted.release()

        self._http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._http.daemon_threads = True
        self.port = self._http.server_port
        self.receipt = {
            **self.capabilities(),
            "port": self.port,
            "sessionToken": secrets.token_urlsafe(32),
        }

    def capabilities(self) -> dict:
        return {
            "contract": CONTRACT,
            "platform": platform.system(),
            "pid": self.pid,
            "geometry": {
                "tilePx": geometry.TILE_PX,
                "baseBinBp": geometry.BASE_BIN_BP,
                "levelFactor": geometry.LEVEL_FACTOR,
            },
            "generation": self.generation,
            "header": self.header,
            "capabilities": {
                "alignment": True,
                "coverage": True,
                "readDetails": True,
                "coveragePreparation": "explicit-cli",
            },
        }

    def _require_generation(self) -> None:
        pileup.require_aligned_read_source_generation(
            self.alignment, self.index, self.reference, self.generation
        )

    def _require_source(self, body: _SourceBody) -> None:
        if (
            body.bam_path != self.alignment
            or body.index_path != self.index
            or body.reference_path != self.reference
        ):
            raise ValueError("The request names another source.")
        if (
            body.source_generation is not None
            and body.source_generation != self.generation
        ):
            raise pileup.SourceGenerationChangedError(
                "The request names another generation."
            )

    def calculate(self, kind: str, level: int, index: int, body: _TileBody) -> dict:
        if kind == "coverage-assembly":
            from .services.coverage_pyramid import coverage_assembly_tile

            if not body.segments:
                raise ValueError("Assembly coverage needs chromosome segments.")
            result = coverage_assembly_tile(
                self.alignment,
                [
                    {
                        "chrom": s.chrom,
                        "start": s.start,
                        "end": s.end,
                        "globalStart": s.chrom_global_start,
                    }
                    for s in body.segments
                ],
                bins=geometry.TILE_PX,
                bin_size_bp=geometry.bin_bp(level),
                index_path=self.index,
                reference_fasta=self.reference,
            )
            return {**result, "level": level, "tileIndex": index}
        if body.chrom not in self.lengths:
            raise ValueError("The source does not contain that chromosome.")
        start = max(
            0, geometry.tile_global_start(index, level) - body.chrom_global_start
        )
        end = max(
            start,
            min(
                self.lengths[body.chrom],
                geometry.tile_global_end(index, level) - body.chrom_global_start,
            ),
        )
        if kind == "alignment":
            return alignment_tiles.alignment_tile(
                self.alignment,
                body.chrom,
                start,
                end,
                level=level,
                tile_index=index,
                index_path=self.index,
                reference_fasta=self.reference,
                guides_only=body.guides_only,
            )
        from .services.coverage_pyramid import coverage_tile

        if end <= start:
            return {
                "chrom": body.chrom,
                "start": start,
                "end": end,
                "bins": [],
                "binSize": 0,
                "maxDepth": 0,
                "level": level,
                "tileIndex": index,
            }
        result = coverage_tile(
            self.alignment,
            body.chrom,
            start,
            end,
            bins=geometry.TILE_PX,
            index_path=self.index,
            reference_fasta=self.reference,
            chrom_len=self.lengths[body.chrom],
        )
        return {**result, "level": level, "tileIndex": index}

    def __enter__(self) -> RemoteTileServer:
        try:
            parent = self.receipt_path.parent.stat()
            if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077:
                raise ValueError(
                    "Put the connection receipt in your own private directory (0700)."
                )
            fd = os.open(self.receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                metadata = os.fstat(output.fileno())
                self._receipt_identity = (metadata.st_dev, metadata.st_ino)
                json.dump(self.receipt, output)
                output.flush()
                os.fsync(output.fileno())
            self._thread = threading.Thread(
                target=self._http.serve_forever, daemon=True
            )
            self._thread.start()
            return self
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if self._thread is not None:
            self._http.shutdown()
            self._thread.join(timeout=5)
            self._thread = None
        self._http.server_close()
        if self._receipt_identity is not None:
            try:
                metadata = self.receipt_path.lstat()
                if (
                    not self.receipt_path.is_symlink()
                    and (metadata.st_dev, metadata.st_ino) == self._receipt_identity
                ):
                    self.receipt_path.unlink()
            except FileNotFoundError:
                pass
            self._receipt_identity = None

    def __exit__(self, *_args) -> None:
        self.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--alignment", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--reference")
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument(
        "--coverage-helper",
        type=Path,
        help="Existing Linux dna-coverage binary; bundled packages supply it automatically.",
    )
    parser.add_argument(
        "--prepare-coverage",
        action="store_true",
        help="Explicitly build the existing coverage pyramid on this compute node.",
    )
    parser.add_argument(
        "--coverage-chromosome",
        action="append",
        help="Chromosome to prepare; repeat for the reference being viewed. Defaults to all source contigs.",
    )
    args = parser.parse_args()
    if args.coverage_helper:
        os.environ["DNA_COVERAGE_PATH"] = str(args.coverage_helper.resolve(strict=True))
    elif not os.environ.get("DNA_COVERAGE_PATH"):
        archive_path = Path(sys.argv[0])
        if archive_path.is_file() and zipfile.is_zipfile(archive_path):
            with zipfile.ZipFile(archive_path) as archive:
                if "hpc-bundle.json" in archive.namelist():
                    import hashlib

                    bundle = json.loads(archive.read("hpc-bundle.json"))[
                        "coverageHelper"
                    ]
                    data = archive.read(bundle["entry"])
                    digest = hashlib.sha256(data).hexdigest()
                    if digest != bundle["sha256"] or len(data) != bundle["bytes"]:
                        parser.error(
                            "The packaged Linux coverage helper failed its checksum."
                        )
                    parent = args.receipt.parent
                    metadata = parent.lstat()
                    if (
                        parent.is_symlink()
                        or metadata.st_uid != os.getuid()
                        or stat.S_IMODE(metadata.st_mode) & 0o077
                    ):
                        parser.error(
                            "Put the receipt in your own private directory (0700)."
                        )
                    helper = parent / ("dna-coverage-" + digest)
                    try:
                        fd = os.open(
                            helper, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700
                        )
                    except FileExistsError:
                        metadata = helper.lstat()
                        if (
                            helper.is_symlink()
                            or metadata.st_uid != os.getuid()
                            or not stat.S_ISREG(metadata.st_mode)
                            or stat.S_IMODE(metadata.st_mode) & 0o077
                            or hashlib.sha256(helper.read_bytes()).hexdigest() != digest
                        ):
                            parser.error(
                                "The existing extracted coverage helper is not this package's owned executable."
                            )
                    else:
                        with os.fdopen(fd, "wb") as output:
                            output.write(data)
                            output.flush()
                            os.fsync(output.fileno())
                    os.environ["DNA_COVERAGE_PATH"] = str(helper)
    coverage_engine_identity()
    os.environ.setdefault(
        "WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR",
        str(args.receipt.parent / "coverage-cache"),
    )
    stop = threading.Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_args: stop.set())
    with RemoteTileServer(
        args.alignment,
        args.index,
        receipt_path=args.receipt,
        reference_path=args.reference,
    ) as server:
        if args.prepare_coverage:
            from .services.coverage_pyramid import coverage_pyramid_precompute

            chromosomes = args.coverage_chromosome or list(server.lengths)
            if any(chrom not in server.lengths for chrom in chromosomes):
                parser.error(
                    "A requested coverage chromosome is absent from this source."
                )
            server._require_generation()
            coverage_pyramid_precompute(
                server.alignment,
                chromosomes,
                index_path=server.index,
                reference_fasta=server.reference,
            )
            server._require_generation()
        print(
            json.dumps(
                {
                    "contract": CONTRACT,
                    "pid": server.pid,
                    "platform": platform.system(),
                    "receiptPath": str(args.receipt),
                    "port": server.port,
                }
            ),
            flush=True,
        )
        stop.wait()


if __name__ == "__main__":
    main()
