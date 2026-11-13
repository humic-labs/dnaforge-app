import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest


def prepare_group_reuse_harness(target: Path) -> tuple[Path, Path]:
    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    source = (native / "lchain.c").read_text()
    assert source.count("    return hash;\n") == 1
    source = source.replace(
        "    return hash;\n", "    return force_group_hash_collision ? 0 : hash;\n"
    )
    for name in ["dnaforge_chain_score_range", "dnaforge_rmq_score_range"]:
        entry = f"static void {name}(dnaforge_chain_work_t *work, int64_t begin, int64_t end)\n{{"
        assert source.count(entry) == 1
        source = source.replace(
            entry, entry + "\n    __sync_add_and_fetch(&group_score_calls, 1);"
        )
    reference = (api / "tests/native/minimap_dp_reference.c").read_bytes()
    assert (
        hashlib.sha256(reference).hexdigest()
        == "91449340e57d0c7967dc0b42c521eeb12d0e3d07712c2385063465d73ccf1c60"
    )
    harness = target / "group-reuse.c"
    harness.write_text(
        "#include <stdint.h>\nstatic uint64_t group_score_calls;\nstatic int force_group_hash_collision;\n"
        + source
        + reference.decode()
        + (api / "tests/native/minimap_group_reuse.c").read_text()
    )
    return harness, native


def compile_group_reuse_harness(harness: Path, native: Path, executable: Path) -> None:
    result = subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O2",
            "-DHAVE_KALLOC",
            "-fsanitize=address,undefined",
            "-fno-sanitize-recover=all",
            "-pthread",
            f"-I{native}",
            str(harness),
            str(native / "kalloc.c"),
            str(native / "misc.c"),
            "-lm",
            "-o",
            str(executable),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_private_cross_query_cache_preserves_complete_state_and_ownership(tmp_path):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    size = "enum { groups = 4, group_size = 16384, count = groups * group_size };"
    actual = "    work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = p[1];"
    penalty = "    work.penalties = dnaforge_prepare_chain_penalties(&work);"
    count = "    if (group_score_calls != expected_calls) {"
    assert source.count(size) == source.count(actual) == source.count(count) == 1
    assert source.count(penalty) == 3
    source = source.replace(
        size,
        "const int groups = 4, group_size = requested_group_size, count = groups * group_size;",
    ).replace(actual, actual + "\n    work.cache = test_cache;")
    source = source.replace(
        count, "    if (!test_cache && group_score_calls != expected_calls) {"
    )
    marker = "    if (scenario == 5) work.chn_pen_gap = 0x1.0p-100f;"
    assert source.count(marker) == 1
    source = source.replace(
        marker, marker + "\n    work.max_skip += test_parameter_variant;"
    )
    payload = "            a[at].y = (13ULL << 32) | (uint32_t)(i * 2);"
    assert source.count(payload) == 1
    source = source.replace(
        payload,
        payload + "\n            a[at].y |= (uint64_t)test_payload_variant << 40;",
    )
    main = r"""
static int cached_case(int method, int scenario, uint64_t expected)
{
    int result = check_group_reuse(method, scenario);
    if (result) return result;
    if (group_score_calls != expected || test_cache->bytes > test_cache->limit || test_cache->peak > test_cache->limit) {
        printf("{\"method\":%d,\"scenario\":%d,\"calls\":%llu,\"expected\":%llu}\n", method, scenario,
            (unsigned long long)group_score_calls, (unsigned long long)expected);
        return 89;
    }
    return 0;
}

int main(void)
{
    requested_group_size = 512;
    test_cache = dnaforge_chain_cache_init(64ULL << 20);
    if (!test_cache) return 90;
    for (int method = 0; method < 2; ++method) {
        int result = cached_case(method, 0, 2); if (result) return result;
        result = cached_case(method, 0, 1); if (result) return result;
        for (int scenario = 4; scenario <= 8; ++scenario) {
            if (scenario == 5 || scenario == 6) continue;
            result = cached_case(method, scenario, 1); if (result) return result;
        }
        for (int scenario = 2; scenario <= 3; ++scenario) {
            result = cached_case(method, scenario, 4); if (result) return result;
        }
        result = cached_case(method, 5, 4); if (result) return result;
        result = cached_case(method, 9, 4); if (result) return result;
        result = cached_case(method, 1, 3); if (result) return result;
        result = cached_case(method, 1, 1); if (result) return result;
        test_payload_variant = 1;
        result = cached_case(method, 1, 3); if (result) return result;
        result = cached_case(method, 1, 1); if (result) return result;
        test_payload_variant = 0;
        test_parameter_variant = 1;
        result = cached_case(method, 0, 2); if (result) return result;
        result = cached_case(method, 0, 1); if (result) return result;
        test_parameter_variant = 0;
    }
    requested_group_size = 16384;
    int result = cached_case(0, 1, 3); if (result) return result;
    result = cached_case(0, 1, 1); if (result) return result;
    if (!test_cache->hits || !test_cache->misses) return 91;
    dnaforge_chain_cache_destroy(test_cache);
    requested_group_size = 512;
    test_cache = dnaforge_chain_cache_init(sizeof(*test_cache) + sizeof(dnaforge_chain_cache_entry_t) + 512 * sizeof(dnaforge_cached_anchor_t));
    if (!test_cache || test_cache->hits || test_cache->entries) return 92;
    for (int parameter = 0; parameter < 3; ++parameter) {
        test_parameter_variant = parameter & 1;
        result = cached_case(0, 0, 2); if (result) return result;
        if (test_cache->entries != 1) return 93;
    }
    dnaforge_chain_cache_destroy(test_cache);
    test_cache = 0;
    if (dnaforge_chain_cache_init(0)) return 94;
    return 0;
}
"""
    harness.write_text(
        '#include "mmpriv.h"\nstatic dnaforge_chain_cache_t *test_cache;\n'
        + "static int test_parameter_variant, test_payload_variant, requested_group_size;\n"
        + source
        + main
    )
    executable = tmp_path / "private-cross-query-state"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
@pytest.mark.parametrize("maximum_iterations", [1, 2, 27])
def test_bucket_cursor_boundary_preserves_complete_original_state(
    tmp_path, maximum_iterations
):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    original_size = (
        "enum { groups = 4, group_size = 16384, count = groups * group_size };"
    )
    assert source.count(original_size) == 1
    assert source.count(".max_skip = 25, .max_iter = 5000") == 1
    assert source.count("long cpus = sysconf(_SC_NPROCESSORS_ONLN);") == 1
    source = source.replace(
        original_size,
        "const int groups = 4, group_size = requested_group_size, count = groups * group_size;",
    ).replace(
        ".max_skip = 25, .max_iter = 5000",
        f".max_skip = {25 if maximum_iterations == 27 else 0}, .max_iter = {maximum_iterations}",
    )
    source = source.replace(
        "long cpus = sysconf(_SC_NPROCESSORS_ONLN);", "long cpus = 1;"
    )
    harness.write_text(
        "static int requested_group_size;\n"
        + source
        + "int main(void) { for (int size = 65535; size <= 65536; ++size) { "
        + "requested_group_size = size; int result = check_group_reuse(0, 0); "
        + "if (result) return result; } return 0; }\n"
    )
    executable = tmp_path / "cursor-boundary-state"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
@pytest.mark.parametrize("expired", [False, True])
def test_interleaved_coherent_chains_preserve_state_with_bounded_work(
    tmp_path, expired
):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    source = source.replace("group_size = 16384", "group_size = 512")
    x = "a[at].x = ((uint64_t)(group + 3) << 32) | x;"
    y = "a[at].y = (13ULL << 32) | (uint32_t)(i * 2);"
    assert source.count(x) == source.count(y) == 1
    source = source.replace(
        x, "a[at].x = ((uint64_t)(group + 3) << 32) | (uint32_t)((i / 2) * 2);"
    ).replace(y, "a[at].y = (13ULL << 32) | (uint32_t)((i / 2) * 2 + (i % 2) * 20000);")
    if expired:
        source = source.replace(
            "(uint32_t)((i / 2) * 2);",
            "(uint32_t)((i / 2) * 2 + (i / 256) * 16384);",
        )
    score = "    return dnaforge_comput_cached_sc(&ai, &aj,"
    assert source.count(score) == 1
    source = source.replace(score, "    ++packed_score_calls;\n" + score)
    harness.write_text(
        "#include <stdint.h>\nstatic uint64_t packed_score_calls;\n"
        + source
        + "int main(void) { for (int scenario = 0; scenario < 2; ++scenario) {\n"
        + "packed_score_calls = 0; int result = check_group_reuse(0, scenario); "
        + "if (result) return result;\n"
        + "if (packed_score_calls > 512 * (scenario ? 4 : 3) * 4) { "
        + 'printf("{\\"scenario\\":%d,\\"scoreCalls\\":%llu}\\n", scenario, '
        + "(unsigned long long)packed_score_calls); return 87; } } return 0; }\n"
    )
    executable = tmp_path / "interleaved-chain-state"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
@pytest.mark.parametrize("representation", ["dense", "packed"])
def test_coherent_skip_keeps_the_original_later_maximum_fallback(
    tmp_path, representation
):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    source = source.replace("group_size = 16384", "group_size = 512")
    x = "a[at].x = ((uint64_t)(group + 3) << 32) | x;"
    y = "a[at].y = (13ULL << 32) | (uint32_t)(i * 2);"
    fallback = (
        "            if (score != INT32_MIN && max_f < score + state[max_ii].score) {"
    )
    dense_fallback = (
        "            if (score != INT32_MIN && max_f < score + nodes[max_ii].score) {"
    )
    assert source.count(x) == source.count(y) == source.count(fallback) == 1
    assert source.count(dense_fallback) == 1
    assert source.count(".max_skip = 25, .max_iter = 5000") == 1
    source = (
        source.replace(
            x,
            "a[at].x = ((uint64_t)(group + 3) << 32) | "
            "(uint32_t)(i < 128 ? i * 10 : 1272 + (i - 128) * 2);",
        )
        .replace(
            y,
            "a[at].y = (13ULL << 32) | "
            "(uint32_t)(i < 128 ? i * 10 : 972 + (i - 128) * 2);",
        )
        .replace(".max_skip = 25, .max_iter = 5000", ".max_skip = 25, .max_iter = 27")
        .replace(
            fallback, fallback + "\n                if (take_fast) ++fast_fallbacks;"
        )
        .replace(
            dense_fallback,
            dense_fallback + "\n                if (shortcut) ++fast_fallbacks;",
        )
    )
    if representation == "packed":
        dispatch = "    if (dnaforge_chain_score_range_dense(work,"
        assert source.count(dispatch) == 1
        source = source.replace(
            dispatch, "    if (0 && dnaforge_chain_score_range_dense(work,"
        )
    harness.write_text(
        "#include <stdint.h>\nstatic uint64_t fast_fallbacks;\n"
        + source
        + "int main(void) { for (int scenario = 0; scenario < 2; ++scenario) { "
        + "fast_fallbacks = 0; int result = check_group_reuse(0, scenario); "
        + "if (result) return result; if (!fast_fallbacks) return 88; } return 0; }\n"
    )
    executable = tmp_path / "coherent-original-fallback"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_coherent_runs_preserve_complete_state_with_bounded_score_work(tmp_path):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    source = source.replace("group_size = 16384", "group_size = 512")
    score = "    return dnaforge_comput_cached_sc(&ai, &aj,"
    assert source.count(score) == 1
    source = source.replace(score, "    ++packed_score_calls;\n" + score)
    harness.write_text(
        "#include <stdint.h>\nstatic uint64_t packed_score_calls;\n"
        + source
        + "int main(void) { for (int scenario = 0; scenario < 2; ++scenario) {\n"
        + "packed_score_calls = 0; int result = check_group_reuse(0, scenario); "
        + "if (result) return result;\n"
        + "if (packed_score_calls > 512 * (scenario ? 3 : 2) * 4) { "
        + 'printf("{\\"scenario\\":%d,\\"scoreCalls\\":%llu}\\n", scenario, '
        + "(unsigned long long)packed_score_calls); return 86; } } return 0; }\n"
    )
    executable = tmp_path / "coherent-run-state"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_query_translations_preserve_complete_state_and_precision_fallback(tmp_path):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    assert source.count("group_size = 16384") == 1
    source = source.replace("group_size = 16384", "group_size = 512")
    harness.write_text(
        source
        + "int main(void) { int cases = 0;\n"
        + "for (int method = 0; method < 2; ++method)\n"
        + "for (int scenario = 7; scenario <= 9; ++scenario) {\n"
        + "int result = check_group_reuse(method, scenario); if (result) return result; ++cases; }\n"
        + 'printf("%d\\n", cases); return 0; }\n'
    )
    executable = tmp_path / "query-translated-state"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "6"


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_serial_moderate_batches_preserve_group_state_and_boundary_fallback(tmp_path):
    harness, native = prepare_group_reuse_harness(tmp_path)
    source = harness.read_text().split("int main(int argc, char **argv)", 1)[0]
    assert source.count("group_size = 16384") == 1
    assert source.count("long cpus = sysconf(_SC_NPROCESSORS_ONLN);") == 1
    source = source.replace("group_size = 16384", "group_size = 512").replace(
        "long cpus = sysconf(_SC_NPROCESSORS_ONLN);", "long cpus = 1;"
    )
    harness.write_text(
        source
        + "int main(void) {\n"
        + "for (int method = 0; method < 2; ++method)\n"
        + "for (int scenario = 0; scenario < 6; ++scenario) {\n"
        + "int result = check_group_reuse(method, scenario); if (result) return result; }\n"
        + "int result = check_group_reuse(0, 6); if (result) return result;\n"
        + 'puts("{\\"cases\\":13,\\"serialGroupStateExact\\":true,\\"unsafeBoundaryRetainsOriginal\\":true}"); return 0; }\n'
    )
    executable = tmp_path / "serial-group-state"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout) == {
        "cases": 13,
        "serialGroupStateExact": True,
        "unsafeBoundaryRetainsOriginal": True,
    }


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_exact_group_reuse_preserves_complete_state_and_independent_fallbacks(tmp_path):
    harness, native = prepare_group_reuse_harness(tmp_path)
    executable = tmp_path / "group-reuse"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report == {
        "cases": 12,
        "completeStatesExact": True,
        "hashCollisionsComparedExactly": True,
        "firstGroupIndependent": True,
        "nonzeroInputAndOverflowFallbackExact": True,
        "exactTranslationAndPrecisionFallback": True,
        "joinedBeforeReuse": True,
    }
