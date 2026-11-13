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
def test_radix_sort_preserves_upstream_arrays_and_avoids_constant_prefix_passes(
    tmp_path,
):
    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    fixtures = api / "tests/native"
    reference = (fixtures / "minimap_radix_reference.h").read_text()
    start = reference.index("#define KRADIX_SORT_INIT(")
    end = reference.rindex("#endif")
    original_macro = reference[start:end].replace(
        "#define KRADIX_SORT_INIT(", "#define DNAFORGE_REFERENCE_RADIX_INIT("
    )
    constants = "\n".join(
        line for line in reference.splitlines() if line.startswith("#define RS_")
    )
    for name in ["RS_MAX_BITS", "RS_MIN_SIZE"]:
        original_macro = original_macro.replace(name, "DNAFORGE_REFERENCE_" + name)
        constants = constants.replace(name, "DNAFORGE_REFERENCE_" + name)
    implementation = (native / "misc.c").read_text()
    start = implementation.index("typedef struct dnaforge_seed_sort_schedule_s")
    end = implementation.index("\n#define sort_key_64", start)
    parallel_sort = implementation[start:end]
    assert parallel_sort.count("sysconf(_SC_NPROCESSORS_ONLN)") == 1
    assert parallel_sort.count("pthread_create(") == 1
    parallel_sort = parallel_sort.replace(
        "sysconf(_SC_NPROCESSORS_ONLN)", "test_cpu_count"
    )
    parallel_sort = parallel_sort.replace("pthread_create(", "test_pthread_create(")
    harness = tmp_path / "radix-exact.c"
    harness.write_text(
        "#include <stdint.h>\n#include <stdlib.h>\n#include <stdio.h>\n#include <string.h>\n#include <pthread.h>\n"
        '#include "mmpriv.h"\n#include "ksort.h"\n'
        "static uint64_t candidate_key_reads, reference_key_reads;\n"
        "static uint64_t candidate128_key(mm128_t v) { ++candidate_key_reads; return v.x; }\n"
        "static uint64_t reference128_key(mm128_t v) { ++reference_key_reads; return v.x; }\n"
        "static uint64_t candidate64_key(uint64_t v) { ++candidate_key_reads; return v; }\n"
        "static uint64_t reference64_key(uint64_t v) { ++reference_key_reads; return v; }\n"
        "static uint64_t pure128_key(mm128_t v) { return v.x; }\n"
        "static long test_cpu_count = 2;\n"
        "static int test_create_calls, test_create_successes, test_create_failure;\n"
        "static int test_pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*entry)(void *), void *data) {\n"
        "++test_create_calls; if (test_create_failure) return 1;\n"
        "int result = pthread_create(thread, attr, entry, data);\n"
        "if (result == 0) ++test_create_successes; return result; }\n"
        "KRADIX_SORT_INIT(candidate128, mm128_t, candidate128_key, 8)\n"
        "KRADIX_SORT_INIT(candidate64, uint64_t, candidate64_key, 8)\n"
        "KRADIX_SORT_INIT(128x, mm128_t, pure128_key, 8)\n"
        + parallel_sort
        + constants
        + "\n"
        + original_macro
        + "\nDNAFORGE_REFERENCE_RADIX_INIT(reference128, mm128_t, reference128_key, 8)\n"
        "DNAFORGE_REFERENCE_RADIX_INIT(reference64, uint64_t, reference64_key, 8)\n"
        + (fixtures / "minimap_radix_sort.c").read_text()
    )
    executable = tmp_path / "radix-exact"
    compilation = subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            "-fsanitize=address,undefined",
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
    assert report["cases"] == 96
    assert report["parallelCases"] == 7
    assert report["parallelAndFallbackArraysByteExact"] is True
    assert report["workerCreateCalls"] == 3
    assert report["workersCreated"] == 2
    assert report["completePairAnd64ArraysByteExact"] is True
    assert report["tiedKeyPayloadOrderExact"] is True
    assert report["constantKeysSinglePass"] is True
    assert report["inheritedPrefixCases"] == 2
    assert report["inheritedConstantDigitPassesSkipped"] is True
    assert report["constantCandidateKeyReads"] < report["constantReferenceKeyReads"]
    assert report["failures"] == 0
