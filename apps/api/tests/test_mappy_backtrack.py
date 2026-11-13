import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_single_pass_backtrack_preserves_original_state_and_reduces_chain_walks(
    tmp_path,
):
    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    fixtures = api / "tests/native"
    source = (native / "lchain.c").read_text()
    source = source[: source.index("\nstatic mm128_t *compact_a")]
    reference = (fixtures / "minimap_backtrack_reference.c").read_text()
    reference = reference.replace(
        "mg_chain_bk_end(", "dnaforge_reference_mg_chain_bk_end("
    )
    reference = reference.replace(
        "mg_chain_backtrack(", "dnaforge_reference_mg_chain_backtrack("
    )

    def observe(text, name, counter):
        start = text.index("static int64_t " + name + "(")
        body = text.index("{", start)
        return text[: body + 1] + "\n    ++" + counter + ";" + text[body + 1 :]

    source = observe(source, "mg_chain_bk_end", "candidate_walks")
    reference = observe(
        reference, "dnaforge_reference_mg_chain_bk_end", "reference_walks"
    )
    harness = tmp_path / "backtrack-exact.c"
    harness.write_text(
        "#include <stdint.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n"
        "static uint64_t candidate_walks, reference_walks;\n"
        + source
        + '\n#include "ksort.h"\n#define dnaforge_test_key(a) ((a).x)\n'
        "KRADIX_SORT_INIT(128x, mm128_t, dnaforge_test_key, 8)\n"
        + reference
        + (fixtures / "minimap_backtrack_state.c").read_text()
    )
    executable = tmp_path / "backtrack-exact"
    compilation = subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            "-DHAVE_KALLOC",
            "-fsanitize=address,undefined",
            "-fno-sanitize-recover=all",
            "-pthread",
            f"-I{native}",
            str(harness),
            str(native / "kalloc.c"),
            "-lm",
            "-o",
            str(executable),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert compilation.returncode == 0, compilation.stdout + compilation.stderr
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["cases"] == 240
    assert report["completeUvTStateExact"] is True
    assert report["inputFpUnchanged"] is True
    assert report["bothAllocatorModes"] is True
    assert report["walksAtMostHalfOriginal"] is True
    assert report["candidateWalks"] * 2 <= report["referenceWalks"]
    assert report["failures"] == 0
