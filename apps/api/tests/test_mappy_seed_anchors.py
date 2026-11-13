import hashlib
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
@pytest.mark.parametrize("sanitizers", ["address,undefined", "thread"])
def test_seed_preparation_preserves_original_complete_anchor_words_and_order(
    tmp_path, sanitizers
):
    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    source = (native / "map.c").read_text()
    start = source.index("static inline int dnaforge_seed_fill_supported(")
    end = source.index("static mm128_t *collect_seed_hits_heap(", start)
    helpers = source[start:end]
    assert helpers.count("sysconf(_SC_NPROCESSORS_ONLN)") == 1
    assert helpers.count("pthread_create(") == 1
    helpers = helpers.replace("sysconf(_SC_NPROCESSORS_ONLN)", "test_cpu_count")
    helpers = helpers.replace("pthread_create(", "test_pthread_create(")
    reference = api / "tests/native/minimap_seed_anchor_reference.h"
    assert (
        hashlib.sha256(reference.read_bytes()).hexdigest()
        == "df7c309b6370c9279cb77b82823994439d5924262dd65a8481735a0a29c19b2c"
    )
    harness = tmp_path / "seed-anchors.c"
    harness.write_text(
        "#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <pthread.h>\n"
        '#include "mmpriv.h"\n'
        "static int test_cpu_count = 2, test_fail_create = 0, test_create_calls = 0, test_created_threads = 0;\n"
        "static int test_pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*entry)(void *), void *arg) {\n"
        "++test_create_calls; if (test_fail_create) return 1;\n"
        "int result = pthread_create(thread, attr, entry, arg); if (!result) ++test_created_threads; return result; }\n"
        + helpers
        + reference.read_text()
        + (api / "tests/native/minimap_seed_anchors.c").read_text()
    )
    executable = tmp_path / "seed-anchors"
    compilation = subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            f"-fsanitize={sanitizers}",
            "-fno-sanitize-recover=all",
            "-pthread",
            f"-I{native}",
            str(harness),
            "-o",
            str(executable),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert compilation.returncode == 0, compilation.stdout + compilation.stderr
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["cases"] == 256
    assert report["anchors"] == 2_000_000
    assert report["guardCases"] == 195
    assert report["allOriginalAnchorWordsAndOrderExact"] is True
    assert report["untouchedBoundariesExact"] is True
    assert report["unsupportedFlagsAndNamesUseFallback"] is True
    assert report["batchCases"] == 8
    assert report["completeBatchAnchorWordsAndOrderExact"] is True
    assert report["capacityAndNameRefusalsUntouched"] is True
    assert report["createCalls"] == 3
    assert report["createdThreads"] == 2
    assert report["failures"] == 0
