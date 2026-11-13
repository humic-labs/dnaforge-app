from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import tempfile
import threading
import time
from pathlib import Path

from dnaforge_annotation.iupac import reverse_complement

from src.fastq_preprocessing_contract import (
    FastqPreprocessingRequest,
    FastqPreprocessingSubmission,
    prepare_fastq_preprocessing,
)
from src.ngs_read_analysis_contract import NgsReadAnalysisSubject
from src.services.fastq_preprocessing import _fastq_records, execute_fastq_preprocessing


async def qualify(pairs: int, parent: Path):
    if pairs < 1:
        raise ValueError("The qualification needs at least one pair.")
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="paired-fastq-qualification-", dir=parent))
    os.environ["DNAFORGE_FASTQ_PREPARATION_CACHE_DIR"] = str(root / "outputs")
    insert = "ATGGCGTACCGTATCGATGCTACGTAGCTAGCTGATCGATCGTGACTGACGTACGATCGATGCTACGTACGATGCTAGCTACGTAGCTAGCT"
    reverse = reverse_complement(insert)
    adapters = [
        "AGATCGGAAGAGCACACGTCTGAACTCCAGTCA",
        "AGATCGGAAGAGCGTCGTGTAGGGAAAGAGTGT",
    ]
    paths = [root / "r1.fastq.gz", root / "r2.fastq.gz"]
    started = time.monotonic()
    for mate, (path, sequence, adapter) in enumerate(
        zip(paths, (insert, reverse), adapters, strict=True), 1
    ):
        read = sequence + adapter
        record = f"@repeated-biological-oracle/{mate}\n{read}\n+\n{'I' * len(read)}\n".encode()
        block = record * 10_000
        with gzip.open(path, "wb", compresslevel=1) as stream:
            for _ in range(pairs // 10_000):
                stream.write(block)
            stream.write(record * (pairs % 10_000))
    generation_seconds = time.monotonic() - started
    print(
        json.dumps(
            {
                "phase": "generated",
                "pairs": pairs,
                "root": str(root),
                "seconds": generation_seconds,
            }
        ),
        flush=True,
    )
    submission = FastqPreprocessingSubmission(
        submission_key="scale-oracle",
        subject=NgsReadAnalysisSubject(scope_id="synthetic-qualification"),
        input=FastqPreprocessingRequest(
            read1Path=str(paths[0]),
            read2Path=str(paths[1]),
            adapter1=adapters[0],
            adapter2=adapters[1],
        ),
    )
    result = await execute_fastq_preprocessing(
        prepare_fastq_preprocessing(submission).input, threading.Event()
    )
    if (
        result.input_pairs != pairs
        or result.outputs["merged"].reads != pairs
        or result.outputs["merged"].bases != pairs * len(insert)
        or result.rejected_reads
        or any(
            result.outputs[name].reads
            for name in ("unmerged1", "unmerged2", "unpaired1", "unpaired2", "failed")
        )
    ):
        raise ValueError(
            "Full-count merging and read accounting failed the scale oracle."
        )
    observed = 0
    for record in _fastq_records(
        Path(result.outputs["merged"].path), threading.Event()
    ):
        if record[1] != insert.encode():
            raise ValueError(
                f"The merged biological sequence differs at read {observed + 1}."
            )
        observed += 1
    if observed != pairs:
        raise ValueError("The merged output was sampled or truncated.")
    receipt = {
        "passed": True,
        "inputReads": pairs * 2,
        "inputPairs": pairs,
        "mergedReadsIndividuallyVerified": observed,
        "generationSeconds": generation_seconds,
        "totalSeconds": time.monotonic() - started,
        "result": result.model_dump(mode="json", by_alias=True),
    }
    destination = root / "qualification.json"
    destination.write_text(json.dumps(receipt, indent=2))
    print(
        json.dumps(
            {
                "phase": "passed",
                "receipt": str(destination),
                "inputReads": pairs * 2,
                "mergedReadsIndividuallyVerified": observed,
                "seconds": receipt["totalSeconds"],
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs", type=int, default=10_000_000)
    parser.add_argument("--output-parent", type=Path, required=True)
    arguments = parser.parse_args()
    asyncio.run(qualify(arguments.pairs, arguments.output_parent))
