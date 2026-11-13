import argparse
import hashlib
import json
from pathlib import Path


def instrument(source: str) -> str:
    marker = "static void dnaforge_chain_score_single("
    if source.count(marker) != 1:
        raise ValueError("Expected the original native dispatch boundary")
    helper = (Path(__file__).parent / "native/minimap_chain_profile.h").read_text()
    counter_marker = "static inline int32_t dnaforge_comput_cached_sc("
    if source.count(counter_marker) != 2:
        raise ValueError(
            "Expected the original cached-score declaration and definition"
        )
    source = source.replace(
        counter_marker,
        "static _Thread_local uint64_t dnaforge_chain_profile_counts[10];\n\n"
        + counter_marker,
        1,
    )
    replacements = {
        "void dnaforge_chain_cache_destroy(dnaforge_chain_cache_t *cache)\n{\n    if (!cache) return;": (
            "void dnaforge_chain_cache_destroy(dnaforge_chain_cache_t *cache)\n{\n    if (!cache) return;\n"
            "    dnaforge_chain_profile_cache_finish(cache->hits, cache->misses, cache->peak);"
        ),
        "    int64_t st = 0, max_ii = -1, previous_slot = 0;": (
            "    dnaforge_chain_profile_counts[0] += (uint64_t)count;\n"
            "    int64_t st = 0, max_ii = -1, previous_slot = 0;"
        ),
        "    int64_t st = 0, max_ii = -1, last_slot = 0;": (
            "    dnaforge_chain_profile_counts[0] += (uint64_t)count;\n"
            "    int64_t st = 0, max_ii = -1, last_slot = 0;"
        ),
        "        state[i].fast = 0;": (
            "        dnaforge_chain_profile_counts[1] += fast_enabled != 0;\n"
            "        state[i].fast = 0;"
        ),
        "        nodes[i].fast = 0;": (
            "        dnaforge_chain_profile_counts[1] += fast_enabled != 0;\n"
            "        nodes[i].fast = 0;"
        ),
        "&& (state[entries[current_position - 1].index].fast & 0x7fffffffu) >= stop) {": (
            "&& (state[entries[current_position - 1].index].fast & 0x7fffffffu) >= stop) {\n"
            "            ++dnaforge_chain_profile_counts[2];"
        ),
        "if (fast_enabled && previous_index >= 0 && (nodes[previous_index].fast & 0x7fffffffu) >= stop) {": (
            "if (fast_enabled && previous_index >= 0 && (nodes[previous_index].fast & 0x7fffffffu) >= stop) {\n"
            "            ++dnaforge_chain_profile_counts[2];"
        ),
        "            if (take_fast) {": (
            "            if (own_cursor && isolated && stopping >= st) {\n"
            "                ++dnaforge_chain_profile_counts[3];\n"
            "                if (distance >= 0 && distance <= max_dist_x && distance <= work->max_dist_y)\n"
            "                    ++dnaforge_chain_profile_counts[4];\n"
            "            }\n"
            "            if (take_fast) {\n"
            "                ++dnaforge_chain_profile_counts[5];"
        ),
        "            if (shortcut) {": (
            "            if (own_head && isolated && stopping >= st) {\n"
            "                ++dnaforge_chain_profile_counts[3];\n"
            "                if (distance >= 0 && distance <= max_dist_x && distance <= max_dist_y)\n"
            "                    ++dnaforge_chain_profile_counts[4];\n"
            "            }\n"
            "            if (shortcut) {\n"
            "                ++dnaforge_chain_profile_counts[5];"
        ),
        "    return dnaforge_comput_cached_sc(&ai, &aj,": (
            "    ++dnaforge_chain_profile_counts[6];\n"
            "    return dnaforge_comput_cached_sc(&ai, &aj,"
        ),
        "    const int32_t distance = target_distance < query_distance ? target_distance : query_distance;": (
            "    ++dnaforge_chain_profile_counts[6];\n"
            "    const int32_t distance = target_distance < query_distance ? target_distance : query_distance;"
        ),
        "                if (j < st) { j = st - 1; goto dnaforge_packed_candidates_done; }\n                const dnaforge_chain_entry_t *previous =": (
            "                if (j < st) { j = st - 1; goto dnaforge_packed_candidates_done; }\n"
            "                ++dnaforge_chain_profile_counts[7];\n"
            "                const dnaforge_chain_entry_t *previous ="
        ),
        "                if (j < st) { j = st - 1; goto dnaforge_dense_candidates_done; }\n                candidates[selected] =": (
            "                if (j < st) { j = st - 1; goto dnaforge_dense_candidates_done; }\n"
            "                ++dnaforge_chain_profile_counts[7];\n"
            "                candidates[selected] ="
        ),
        "    const int32_t query = dnaforge_chain_anchor_query(entry);": (
            "    ++dnaforge_chain_profile_counts[8];\n"
            "    const int32_t query = dnaforge_chain_anchor_query(entry);"
        ),
        "            const int first = cursors[0].index >= cursors[1].index ? 0 : 1;": (
            "            ++dnaforge_chain_profile_counts[9];\n"
            "            const int first = cursors[0].index >= cursors[1].index ? 0 : 1;"
        ),
        "            const int left_head = candidates[0] >= candidates[1] ? 0 : 1;": (
            "            ++dnaforge_chain_profile_counts[9];\n"
            "            const int left_head = candidates[0] >= candidates[1] ? 0 : 1;"
        ),
        "    shared->score_range(&local, begin, end);": (
            "    dnaforge_chain_profile_run(&local, begin, end, "
            "shared->score_range == dnaforge_chain_score_range);"
        ),
        "        work->score_range(&local, work->bounds[group], work->bounds[group + 1]);": (
            "        dnaforge_chain_profile_run(&local, work->bounds[group], "
            "work->bounds[group + 1], work->score_range == dnaforge_chain_score_range);"
        ),
    }
    for original, replacement in replacements.items():
        if source.count(original) != 1:
            raise ValueError("Expected an unchanged native scoring dispatch")
        source = source.replace(original, replacement)
    return source.replace(marker, helper + "\n" + marker)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    original = args.source.read_bytes()
    modified = instrument(original.decode()).encode()
    args.source.write_bytes(modified)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "schema": "dnaforge.chain-profile-source.v1",
                "diagnosticOnly": True,
                "originalSha256": hashlib.sha256(original).hexdigest(),
                "instrumentedSha256": hashlib.sha256(modified).hexdigest(),
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
