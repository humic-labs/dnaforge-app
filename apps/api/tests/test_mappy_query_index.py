import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

import pytest


def prepare_query_index_harness(tmp_path: Path) -> tuple[Path, Path]:
    api = Path(__file__).resolve().parents[1]
    native = api / "vendor/mappy"
    source = (native / "lchain.c").read_text()
    start = source.index("static inline int32_t comput_sc(")
    end = source.index("\nstatic void dnaforge_chain_score_single", start)
    scoring_source = source[start:end]
    assert scoring_source.count("\t\t\tsc = ") == 3
    scoring_source = scoring_source.replace(
        "\t\t\tsc = ", "\t\t\t++candidate_score_calls;\n\t\t\tsc = "
    )
    peak_entry = "    return p[i] >= 0 && v[p[i]] > f[i] ? v[p[i]] : f[i];"
    assert scoring_source.count(peak_entry) == 1
    scoring_source = scoring_source.replace(
        peak_entry, "    ++peak_score_calls;\n" + peak_entry
    )
    reference_bytes = (api / "tests/native/minimap_dp_reference.c").read_bytes()
    assert (
        hashlib.sha256(reference_bytes).hexdigest()
        == "91449340e57d0c7967dc0b42c521eeb12d0e3d07712c2385063465d73ccf1c60"
    )
    reference = reference_bytes.decode().replace(
        "\t\t\tsc = ", "\t\t\t++candidate_score_calls;\n\t\t\tsc = "
    )
    assert "dnaforge_chain_peak_at" not in reference
    assert "dnaforge_chain_materialize_peaks" not in reference
    harness = tmp_path / "query-index.c"
    harness.write_text(
        "#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n"
        '#include <string.h>\n#include "mmpriv.h"\n'
        + "static uint64_t candidate_score_calls, peak_score_calls;\n"
        + scoring_source
        + reference
        + (api / "tests/native/minimap_query_index.c").read_text()
    )
    return native, harness


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_moderate_packed_groups_preserve_original_state(tmp_path):
    native, harness = prepare_query_index_harness(tmp_path)
    source = harness.read_text().split("int main(void)", 1)[0]
    harness.write_text(
        source + "int main(void) { return check_small_packed_state(); }\n"
    )
    executable = tmp_path / "small-packed-state"
    result = subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            "-fsanitize=undefined",
            "-fno-sanitize-recover=all",
            f"-I{native}",
            str(harness),
            "-o",
            str(executable),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=8
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_packed_enumeration_reuses_positions_and_contiguous_cursor_runs(tmp_path):
    native, harness = prepare_query_index_harness(tmp_path)
    source = harness.read_text().split("int main(void)", 1)[0]
    declaration = "static uint64_t candidate_score_calls, peak_score_calls;"
    source = source.replace(
        declaration,
        declaration
        + "\nstatic uint64_t bucket_position_evaluations, merge_decisions, candidate_visits, full_score_evaluations;",
        1,
    )
    for marker, counter in [
        (
            "const int32_t query = dnaforge_chain_anchor_query(entry);",
            "bucket_position_evaluations",
        ),
        (
            "const int first = cursors[0].index >= cursors[1].index ? 0 : 1;",
            "merge_decisions",
        ),
        (
            "const int left_head = candidates[0] >= candidates[1] ? 0 : 1;",
            "merge_decisions",
        ),
        ("j = cursors[selected].index;", "candidate_visits"),
        ("j = candidates[selected];", "candidate_visits"),
        (
            "const mm128_t ai = { .x = current->target,",
            "full_score_evaluations",
        ),
    ]:
        assert source.count(marker) == 1
        source = source.replace(marker, f"++{counter};\n            {marker}", 1)
    harness.write_text(source + r"""
int main(void)
{
    uint64_t witness_buckets = 0, witness_merges = 0, witness_visits = 0, witness_full_scores = 0;
    for (int test = 0; test < 3; ++test) {
        const int64_t count = 1536, begin = test == 1 ? 0 : 17;
        const int64_t end = begin + count, allocated = end + 9;
        const int32_t origin = (int32_t[]){0, 0x00a00000, 0x00ff0000}[test];
        mm128_t *a = calloc((size_t)allocated, sizeof(mm128_t));
        int32_t *f[2], *t[2], *v[2];
        int64_t *p[2];
        if (!a) return 81;
        for (int copy = 0; copy < 2; ++copy) {
            f[copy] = calloc((size_t)allocated, sizeof(int32_t));
            t[copy] = calloc((size_t)allocated, sizeof(int32_t));
            v[copy] = calloc((size_t)allocated, sizeof(int32_t));
            p[copy] = malloc((size_t)allocated * sizeof(int64_t));
            if (!f[copy] || !t[copy] || !v[copy] || !p[copy]) return 82;
            for (int64_t i = 0; i < allocated; ++i) p[copy][i] = -1;
        }
        int32_t maximum = 0;
        for (int64_t i = begin; i < end; ++i) {
            const int64_t offset = i - begin;
            const int32_t target = (int32_t)(offset * 5 + (test == 1 ? offset % 3 : 0));
            const int32_t query = origin + (int32_t)(offset * 5)
                + (test == 1 && offset % 5 == 0 ? 100 : 0);
            if (maximum < query) maximum = query;
            a[i].x = (3ULL << 32) | (uint32_t)target;
            a[i].y = (11ULL << 32) | (uint32_t)query;
            t[0][i] = t[1][i] = 1;
        }
        dnaforge_chain_work_t work = {
            .a = a, .max_dist_x = 5000, .max_dist_y = 4900, .bw = 500,
            .max_skip = 25, .max_iter = 5000, .n_seg = 1,
            .chn_pen_gap = 0.19f, .coherent_runs = 1
        };
        work.penalties = dnaforge_prepare_chain_penalties(&work);
        if (!work.penalties) return 83;
        work.f = f[0]; work.t = t[0]; work.v = v[0]; work.p = p[0];
        dnaforge_reference_chain_score_range_original(&work, begin, end);
        work.f = f[1]; work.t = t[1]; work.v = v[1]; work.p = p[1];
        bucket_position_evaluations = merge_decisions = candidate_visits = full_score_evaluations = 0;
        if (!dnaforge_chain_score_range_packed(&work, begin, end, maximum)) return 84;
        if (memcmp(f[0], f[1], (size_t)allocated * sizeof(int32_t)) ||
            memcmp(t[0], t[1], (size_t)allocated * sizeof(int32_t)) ||
            memcmp(v[0], v[1], (size_t)allocated * sizeof(int32_t)) ||
            memcmp(p[0], p[1], (size_t)allocated * sizeof(int64_t))) return 85;
        if (test == 0) {
            witness_buckets = bucket_position_evaluations;
            witness_merges = merge_decisions;
            witness_visits = candidate_visits;
            witness_full_scores = full_score_evaluations;
            if (witness_buckets > (uint64_t)count || witness_merges * 8 >= witness_visits ||
                witness_full_scores * 8 >= witness_visits) {
                printf("{\"completeFrozenStatesExact\":true,\"bucketEvaluations\":%llu,"
                       "\"mergeDecisions\":%llu,\"candidateVisits\":%llu,\"fullScorerEvaluations\":%llu}\n",
                       (unsigned long long)witness_buckets, (unsigned long long)witness_merges,
                       (unsigned long long)witness_visits, (unsigned long long)witness_full_scores);
                return 89;
            }
        }
        free(work.penalties);
        free(a);
        for (int copy = 0; copy < 2; ++copy) {
            free(f[copy]); free(t[copy]); free(v[copy]); free(p[copy]);
        }
    }
    printf("{\"cases\":3,\"completeFrozenStatesExact\":true,\"enumerationWorkBound\":true,"
           "\"bucketEvaluations\":%llu,\"mergeDecisions\":%llu,\"candidateVisits\":%llu,"
           "\"fullScorerEvaluations\":%llu}\n",
           (unsigned long long)witness_buckets, (unsigned long long)witness_merges,
           (unsigned long long)witness_visits, (unsigned long long)witness_full_scores);
    return 0;
}
""")
    executable = tmp_path / "packed-enumeration"
    for command in [
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            "-fsanitize=undefined",
            "-fno-sanitize-recover=all",
            f"-I{native}",
            str(harness),
            "-o",
            str(executable),
        ],
        [str(executable)],
    ]:
        result = subprocess.run(command, capture_output=True, text=True, timeout=8)
        assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["cases"] == 3
    assert report["completeFrozenStatesExact"] is True
    assert report["enumerationWorkBound"] is True


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_validated_candidate_scores_match_frozen_original_boundaries(tmp_path):
    native, harness = prepare_query_index_harness(tmp_path)
    source = harness.read_text().split("int main(void)", 1)[0]
    harness.write_text(source + r"""
int main(void)
{
    uint32_t random = 1907;
    uint64_t cases = 0;
    for (int coefficient = 0; coefficient < 6; ++coefficient) {
        dnaforge_chain_work_t work = {
            .max_dist_x = 5000, .max_dist_y = coefficient % 2 ? 4900 : 5000,
            .bw = 500, .n_seg = 1,
            .chn_pen_gap = (float[]){0.0f, 0.19f, 0.3f, 8.0f, 0x1p-20f, -0.0f}[coefficient]
        };
        work.penalties = dnaforge_prepare_chain_penalties(&work);
        if (!work.penalties) return 91;
        for (int test = 0; test < 20000; ++test) {
            random = random * 1664525u + 1013904223u;
            int32_t query_distance = 1 + random % work.max_dist_y;
            random = random * 1664525u + 1013904223u;
            int32_t target_distance = query_distance + (int32_t)(random % 1001) - 500;
            if (target_distance < 1) target_distance = 1;
            if (target_distance > work.max_dist_x) target_distance = work.max_dist_x;
            switch (test % 7) {
                case 0: query_distance = target_distance = 1; break;
                case 1: query_distance = work.max_dist_y; target_distance = work.max_dist_x; break;
                case 2: query_distance = 501; target_distance = 1; break;
                case 3: query_distance = 1; target_distance = 501; break;
                case 4: query_distance = 4500; target_distance = 5000; break;
            }
            random = random * 1664525u + 1013904223u;
            const int32_t span = test % 11 == 0 ? 0 : test % 11 == 1 ? 255 : random % 256;
            const uint32_t target = (uint32_t[]){0, UINT32_MAX - 5000u, 0x80000000u}[test % 3];
            const uint32_t query = (uint32_t[]){0, 0x00ffffffu - 5000u, 0x00800000u}[test % 3];
            const mm128_t previous = {
                .x = (3ULL << 32) | target,
                .y = (2ULL << MM_SEED_SEG_SHIFT) | ((uint64_t)span << 32) | query
            };
            const mm128_t current = {
                .x = (3ULL << 32) | (target + (uint32_t)target_distance),
                .y = (2ULL << MM_SEED_SEG_SHIFT) | (11ULL << 32) | (query + (uint32_t)query_distance)
            };
            const int32_t diagonal = target_distance > query_distance
                ? target_distance - query_distance : query_distance - target_distance;
            const int32_t expected = dnaforge_reference_comput_sc(&current, &previous,
                work.max_dist_x, work.max_dist_y, work.bw, work.chn_pen_gap, 0.0f, 0, 1);
            const int32_t actual = dnaforge_chain_validated_score(span, query_distance,
                target_distance, diagonal, work.penalties);
            if (expected != actual) {
                fprintf(stderr, "score mismatch coefficient=%d case=%d expected=%d actual=%d\n",
                    coefficient, test, expected, actual);
                return 92;
            }
            ++cases;
        }
        free(work.penalties);
    }
    printf("{\"cases\":%llu,\"frozenOriginalScoresExact\":true,\"coordinateOrigins\":3}\n",
        (unsigned long long)cases);
    return 0;
}
""")
    executable = tmp_path / "validated-candidate-scores"
    for command in [
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            "-fsanitize=undefined",
            "-fno-sanitize-recover=all",
            f"-I{native}",
            str(harness),
            "-o",
            str(executable),
        ],
        [str(executable)],
    ]:
        result = subprocess.run(command, capture_output=True, text=True, timeout=8)
        assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["cases"] == 120000
    assert report["frozenOriginalScoresExact"] is True
    assert report["coordinateOrigins"] == 3


@pytest.mark.skipif(
    sys.platform == "win32", reason="The native aligner is not shipped on Windows."
)
def test_query_index_preserves_complete_original_chaining_state(tmp_path):
    native, harness = prepare_query_index_harness(tmp_path)
    executable = tmp_path / "query-index"
    compile_result = subprocess.run(
        [
            *shlex.split(os.environ.get("CC", "cc")),
            "-O3",
            "-fsanitize=undefined",
            "-fno-sanitize-recover=all",
            f"-I{native}",
            str(harness),
            "-o",
            str(executable),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert compile_result.returncode == 0, compile_result.stdout + compile_result.stderr
    result = subprocess.run(
        [str(executable)], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["diagonalPartitionCases"] == 1
    assert report["queryOriginCases"] == 1
    assert (
        report["queryOriginIndexedScoreCalls"] * 16
        < report["queryOriginScalarScoreCalls"]
    )
    assert report["diagonalIndexedScoreCalls"] * 16 < report["diagonalScalarScoreCalls"]
    assert report["cases"] == 176
    assert report["packedStateCases"] == 10
    assert report["packedFallbackCases"] == 6
    assert report["windowMaximumCases"] == 5
    assert report["cachedScoreCases"] == 2_000_000
    assert report["scorePredecessorPeakSkipArraysExact"] is True
    assert report["smallGroupWorkBoundPassed"] is True
    assert (
        report["smallGroupIndexedScoreCalls"] * 4 < report["smallGroupScalarScoreCalls"]
    )
    assert report["lazyPeakStateCases"] == 176
    assert report["eagerPeakWorkEliminated"] is True
    assert report["failures"] == 0
