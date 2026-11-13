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
def test_parallel_rechaining_preserves_original_state_and_iterator_boundaries(tmp_path):
    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    fixtures = api / "tests/native"
    source = (native / "lchain.c").read_text()
    reference_bytes = (fixtures / "minimap_rmq_reference.c").read_bytes()
    assert (
        hashlib.sha256(reference_bytes).hexdigest()
        == "32f3bedc2c5276ca834ffc2b3370ff870d7f44bf7a7a339dec3f9b6d84cd7086"
    )
    reference = reference_bytes.decode()
    reference = reference.replace("mg_lchain_rmq(", "dnaforge_reference_mg_lchain_rmq(")
    reference = reference.replace(
        "comput_sc_simple(", "dnaforge_reference_comput_sc_simple("
    )
    unused_dp_entry = "mm128_t *mg_lchain_dp("
    assert source.count(unused_dp_entry) == 1
    assert "mg_lchain_dp(" not in (fixtures / "minimap_rmq_state.c").read_text()
    source = source.replace(
        unused_dp_entry, "static mm128_t *dnaforge_test_unused_mg_lchain_dp("
    )
    backtrack = "\tu = mg_chain_backtrack(km, n, f, p, v, t,"
    peak_entry = "    return p[i] >= 0 && v[p[i]] > f[i] ? v[p[i]] : f[i];"
    assert source.count(peak_entry) == 1
    source = source.replace(
        peak_entry, "    __sync_add_and_fetch(&peak_score_calls, 1);\n" + peak_entry
    )
    observe = (
        "\tif (peak_score_calls != 0) exit(38);\n"
        "\tint32_t *snapshot_peaks = malloc((size_t)n * sizeof(int32_t));\n"
        "\tif (!snapshot_peaks) exit(40);\n"
        "\tdnaforge_chain_materialize_peaks(0, n, f, p, snapshot_peaks);\n"
        "\tif (peak_score_calls != (uint64_t)n) exit(39);\n"
        "\tpeak_score_calls = 0;\n"
        "\tdnaforge_observe_state(n, f, p, snapshot_peaks, t);\n"
        "\tfree(snapshot_peaks);\n"
        "\tmemset(v, 0xa5, (size_t)n * sizeof(int32_t));\n" + backtrack
    )
    assert source.count(backtrack) == 2
    assert reference.count(backtrack) == 1
    reference_observed = reference.replace(
        backtrack, "\tdnaforge_observe_state(n, f, p, v, t);\n" + backtrack
    )
    assert "dnaforge_chain_materialize_peaks" not in reference_observed
    assert "peak_score_calls" not in reference_observed
    assert "dnaforge_chain_peak_at" not in reference_observed
    harness = tmp_path / "rmq-state.c"
    harness.write_text(
        (fixtures / "minimap_state_observer.c").read_text()
        + "static uint64_t peak_score_calls;\n"
        + source.replace(backtrack, observe)
        + reference_observed
        + (fixtures / "minimap_rmq_state.c").read_text()
    )
    allocator = (native / "kalloc.c").read_text()
    entry = "void *km_init2(void *km_par, size_t min_core_size)\n{"
    assert allocator.count(entry) == 1
    allocator_path = tmp_path / "allocator.c"
    allocator_path.write_text(
        "extern void dnaforge_observe_arena(void *parent);\n"
        + allocator.replace(entry, entry + "\n    dnaforge_observe_arena(km_par);")
    )
    executable = tmp_path / "rmq-state"
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
            str(allocator_path),
            str(native / "misc.c"),
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
    assert report["cases"] == 120
    assert report["anchors"] == 1_989_174
    assert report["scorePredecessorPeakSkipArraysExact"] is True
    assert report["orderedChainsAndAnchorsExact"] is True
    assert report["iteratorBoundariesExact"] is True
    assert report["shiftedPredecessorIntervalsExact"] is True
    assert report["compressedSparseIntervalsExact"] is True
    assert report["boundedWorkerStorage"] is True
    assert report["cachedSimpleScoreCases"] == 2_000_000
    assert report["cachedSimpleScoresAndFlagsExact"] is True
    assert report["simplePenaltyFallbacksExact"] is True
    assert report["bandedScoreCases"] == 2_000_001
    assert report["bandedAcceptanceAndFlagsExact"] is True
    assert report["rejectedScoresUntouched"] is True
    assert report["failures"] == 0


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_unique_range_minimum_retains_original_ties_and_closed_intervals(tmp_path):
    from tests.test_mappy_group_reuse import compile_group_reuse_harness

    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    fixtures = api / "tests/native"
    reference = (fixtures / "minimap_rmq_reference.c").read_bytes()
    assert hashlib.sha256(reference).hexdigest() == (
        "32f3bedc2c5276ca834ffc2b3370ff870d7f44bf7a7a339dec3f9b6d84cd7086"
    )
    frozen = reference.decode().replace(
        "mg_lchain_rmq(", "dnaforge_reference_mg_lchain_rmq("
    )
    frozen = frozen.replace("comput_sc_simple(", "dnaforge_reference_comput_sc_simple(")
    source = (native / "lchain.c").read_text()
    query = "krmq_rmq(lc_elem, root, &lo, &hi)"
    assert source.count(query) == 1
    source = source.replace(query, f"(++original_range_queries, {query})")
    backtrack = "\tu = mg_chain_backtrack(km, n, f, p, v, t,"
    assert source.count(backtrack) == 2
    assert frozen.count(backtrack) == 1
    source = source.replace(
        backtrack,
        "\tint32_t *snapshot = malloc((size_t)n * sizeof(int32_t));\n"
        "\tif (!snapshot) exit(90);\n"
        "\tdnaforge_chain_materialize_peaks(0, n, f, p, snapshot);\n"
        "\tdnaforge_observe_state(n, f, p, snapshot, t); free(snapshot);\n" + backtrack,
    )
    frozen = frozen.replace(
        backtrack, "\tdnaforge_observe_state(n, f, p, v, t);\n" + backtrack
    )
    main = r"""
int main(void)
{
    uint64_t queries = 0;
    for (int scenario = 0; scenario < 12; ++scenario) {
        const int n = 512;
        mm128_t *anchors[2], *output[2];
        uint64_t *chains[2] = {0, 0};
        int chain_count[2] = {0, 0};
        for (int copy = 0; copy < 2; ++copy) {
            anchors[copy] = calloc(n, sizeof(mm128_t));
            if (!anchors[copy]) return 91;
        }
        uint64_t random = 0x62a9d3b7;
        for (int i = 0; i < n; ++i) {
            random ^= random << 13; random ^= random >> 7; random ^= random << 17;
            const uint32_t target = scenario == 1 ? (uint32_t)(i / 2 * 2)
                : scenario == 7 ? (uint32_t)(i * 8) : (uint32_t)(i * 2);
            uint32_t query = target;
            if (scenario == 2 || scenario == 11) query = (uint32_t)(random % 64) * 16;
            if (scenario == 3) query += 1000000000u;
            const uint32_t span = scenario == 4 ? 0 : scenario == 6 ? 255 : 13;
            const uint64_t group = scenario == 11 ? 3 + (uint64_t)i / 128 : 3;
            anchors[0][i].x = group << 32 | target;
            anchors[0][i].y = (uint64_t)span << 32 | query;
        }
        memcpy(anchors[1], anchors[0], n * sizeof(mm128_t));
        const int distance = scenario == 7 ? 16 : 1280;
        const int cap = scenario == 8 ? 1 : scenario == 9 ? 2 : 100000;
        const float gap = scenario == 4 ? 0.0f : scenario == 5 ? -0.1f
            : scenario == 10 ? -0.0f : 0.19f;
        observed_slot = 0;
        original_range_queries = 0;
        output[0] = mg_lchain_rmq(distance, 100, 500, 25, cap, 1, 5, gap, 0.0f,
            n, anchors[0], &chain_count[0], &chains[0], 0);
        const uint64_t actual_queries = original_range_queries;
        output[1] = dnaforge_reference_mg_lchain_rmq(distance, 100, 500, 25, cap,
            1, 5, gap, 0.0f, n, anchors[1], &chain_count[1], &chains[1], 0);
        if (observed_slot != 2) return 92;
        for (int i = 0; i < n; ++i) {
            if (observed[0].f[i] != observed[1].f[i]
                || observed[0].p[i] != observed[1].p[i]
                || observed[0].v[i] != observed[1].v[i]
                || observed[0].t[i] != observed[1].t[i]) {
                printf("{\"scenario\":%d,\"anchor\":%d,\"stateExact\":false}\n", scenario, i);
                return 93;
            }
        }
        if (chain_count[0] != chain_count[1]
            || (chain_count[0] && memcmp(chains[0], chains[1], chain_count[0] * sizeof(uint64_t)))) return 94;
        int used = 0;
        for (int i = 0; i < chain_count[0]; ++i) used += (uint32_t)chains[0][i];
        if (used && memcmp(output[0], output[1], used * sizeof(mm128_t))) return 95;
        for (int copy = 0; copy < 2; ++copy) {
            free(output[copy]); free(chains[copy]);
            free(observed[copy].f); free(observed[copy].p);
            free(observed[copy].v); free(observed[copy].t);
        }
        if (scenario == 0) {
            queries = actual_queries;
            if (queries > n / 8) {
                printf("{\"completeFrozenStateExact\":true,\"originalRangeQueries\":%llu}\n",
                    (unsigned long long)queries);
                return 89;
            }
        }
    }
    printf("{\"cases\":12,\"completeFrozenStateAndReconstructionExact\":true,\"originalRangeQueries\":%llu}\n",
        (unsigned long long)queries);
    return 0;
}
"""
    harness = tmp_path / "unique-range-minimum.c"
    harness.write_text(
        (fixtures / "minimap_state_observer.c").read_text()
        + "static uint64_t original_range_queries;\n"
        + source
        + frozen
        + main
    )
    executable = tmp_path / "unique-range-minimum"
    compile_group_reuse_harness(harness, native, executable)
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["cases"] == 12
    assert report["completeFrozenStateAndReconstructionExact"] is True
    assert report["originalRangeQueries"] <= 64
