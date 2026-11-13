static uint64_t random_state = 0x53b0967caa1d2e49ULL;

static uint64_t next_random(void)
{
    random_state ^= random_state << 13;
    random_state ^= random_state >> 7;
    random_state ^= random_state << 17;
    return random_state;
}

static int check_parallel_batches(void)
{
    const int64_t totals[] = {0, 17, (1U << 20) - 1, 1U << 20, (1U << 20) + 1, (1U << 20) + 7, (1U << 20) + 31, (1U << 20) + 127};
    for (int test = 0; test < 8; ++test) {
        const int64_t total = totals[test];
        const int seed_count = test == 6 ? 1 : 64;
        uint64_t *positions = malloc(((size_t)total + 1) * sizeof(uint64_t));
        mm128_t *actual = malloc(((size_t)total + 2) * sizeof(mm128_t));
        mm128_t *expected = malloc(((size_t)total + 2) * sizeof(mm128_t));
        mm_seed_t *seeds = calloc((size_t)seed_count, sizeof(mm_seed_t));
        if (!positions || !actual || !expected || !seeds) return 30;
        for (int64_t i = 0; i < total; ++i) positions[i] = next_random();
        memset(actual, 0xa5, ((size_t)total + 2) * sizeof(mm128_t));
        memcpy(expected, actual, ((size_t)total + 2) * sizeof(mm128_t));
        int weight_total = 0;
        for (int i = 0; i < seed_count; ++i)
            weight_total += seed_count == 1 ? 1 : test == 7 && i == 1 ? 200 : i % 7 == 0 ? 0 : 1 + i % 5;
        int weight_offset = 0;
        int64_t emitted = 0;
        mm_mapopt_t options = { .flag = 0 };
        for (int i = 0; i < seed_count; ++i) {
            const int weight = seed_count == 1 ? 1 : test == 7 && i == 1 ? 200 : i % 7 == 0 ? 0 : 1 + i % 5;
            const int64_t begin = total * weight_offset / weight_total;
            weight_offset += weight;
            const int64_t end = total * weight_offset / weight_total;
            seeds[i].n = (uint32_t)(end - begin);
            seeds[i].q_pos = (uint32_t)next_random();
            seeds[i].q_span = (uint32_t)(next_random() & 0x7fffffffU);
            seeds[i].seg_id = (uint32_t)(next_random() & 0x7fffffffU);
            seeds[i].is_tandem = i & 1;
            seeds[i].cr = seeds[i].n ? positions + begin : NULL;
            emitted += reference_fill_seed_anchors(expected + 1 + begin, &seeds[i], &options, INT32_MAX);
        }
        if (emitted != total) return 31;
        if (dnaforge_prepare_seed_anchors(actual + 1, seeds, seed_count, total + 1, 0, NULL, INT32_MAX)) return 32;
        if (dnaforge_prepare_seed_anchors(actual + 1, seeds, seed_count, total, 0, "named", INT32_MAX)) return 33;
        for (size_t i = 0; i < ((size_t)total + 2) * sizeof(mm128_t); ++i)
            if (((unsigned char *)actual)[i] != 0xa5) return 34;
        test_cpu_count = test == 4 ? 1 : 2;
        test_fail_create = test == 5;
        const int previous_calls = test_create_calls;
        if (!dnaforge_prepare_seed_anchors(actual + 1, seeds, seed_count, total, 0, NULL, INT32_MAX)) return 35;
        if (memcmp(actual, expected, ((size_t)total + 2) * sizeof(mm128_t))) return 36;
        const int expected_attempts = test == 3 || test == 5 || test == 7;
        if (test_create_calls - previous_calls != expected_attempts) return 37;
        free(positions);
        free(actual);
        free(expected);
        free(seeds);
    }
    return test_create_calls == 3 && test_created_threads == 2 ? 0 : 38;
}

int main(void)
{
    uint64_t guard_cases = 0, compared = 0;
    for (int bit = 0; bit <= 64; ++bit) {
        const uint64_t bits = bit == 0 ? 0 : 1ULL << (bit - 1);
        int64_t flag;
        memcpy(&flag, &bits, sizeof(flag));
        const int expected = !(bits & (MM_F_FOR_ONLY | MM_F_REV_ONLY | MM_F_QSTRAND));
        if (dnaforge_seed_fill_supported(flag, 0) != expected) return 1;
        if (dnaforge_seed_fill_supported(flag, "")) return 2;
        if (dnaforge_seed_fill_supported(flag, "named-query")) return 3;
        guard_cases += 3;
    }
    const uint32_t small[] = {0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 65, 127, 128};
    const int64_t flags[] = {0, MM_F_NO_DIAG, MM_F_NO_DUAL, MM_F_NO_DIAG | MM_F_NO_DUAL, MM_F_NO_HASH_NAME, ~(MM_F_FOR_ONLY | MM_F_REV_ONLY | MM_F_QSTRAND)};
    for (int test = 0; test < 256; ++test) {
        const uint32_t count = test < 16 ? small[test] : test == 255 ? (uint32_t)(2000000 - compared) : 8000;
        uint64_t *positions = malloc(((size_t)count + 1) * sizeof(uint64_t));
        mm128_t *actual = malloc(((size_t)count + 2) * sizeof(mm128_t));
        mm128_t *expected = malloc(((size_t)count + 2) * sizeof(mm128_t));
        if (!positions || !actual || !expected) return 20;
        for (uint32_t i = 0; i < count; ++i) positions[i] = next_random();
        memset(actual, 0xa5, ((size_t)count + 2) * sizeof(mm128_t));
        memcpy(expected, actual, ((size_t)count + 2) * sizeof(mm128_t));
        mm_seed_t seed = {
            .n = count,
            .q_pos = test == 0 ? 0 : test == 1 ? UINT32_MAX : (uint32_t)next_random(),
            .q_span = test == 0 ? 0 : test == 1 ? 1 : test == 2 ? 255 : (uint32_t)(next_random() & 0x7fffffffU),
            .seg_id = (uint32_t)(next_random() & 0x7fffffffU),
            .is_tandem = test & 1,
            .cr = positions,
        };
        const int length = test == 0 ? 0 : test == 1 ? 1 : test == 2 ? INT32_MAX : test == 3 ? INT32_MIN : (int32_t)next_random();
        mm_mapopt_t options = { .flag = flags[test % 6] };
        if (!dnaforge_seed_fill_supported(options.flag, 0)) return 21;
        const int64_t emitted = reference_fill_seed_anchors(expected + 1, &seed, &options, length);
        if (emitted != count) return 22;
        dnaforge_fill_seed_anchors(actual + 1, positions, count, seed.q_pos, seed.q_span, seed.seg_id, seed.is_tandem, length);
        if (memcmp(actual, expected, ((size_t)count + 2) * sizeof(mm128_t))) {
            printf("{\"case\":%d,\"count\":%u,\"exact\":false}\n", test, count);
            return 23;
        }
        compared += count;
        free(positions);
        free(actual);
        free(expected);
    }
    if (compared != 2000000 || guard_cases != 195) return 24;
    const int batch_result = check_parallel_batches();
    if (batch_result) return batch_result;
    printf("{\"cases\":256,\"anchors\":2000000,\"guardCases\":195,\"allOriginalAnchorWordsAndOrderExact\":true,\"untouchedBoundariesExact\":true,\"unsupportedFlagsAndNamesUseFallback\":true,\"batchCases\":8,\"completeBatchAnchorWordsAndOrderExact\":true,\"capacityAndNameRefusalsUntouched\":true,\"createCalls\":3,\"createdThreads\":2,\"failures\":0}\n");
    return 0;
}
