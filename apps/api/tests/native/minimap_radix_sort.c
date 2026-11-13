static uint64_t random_state = 0x2cbd9ef8a1d65037ULL;
static uint64_t next_random(void)
{
    random_state ^= random_state << 13;
    random_state ^= random_state >> 7;
    random_state ^= random_state << 17;
    return random_state;
}

static uint64_t make_key(int mode)
{
    uint64_t value = next_random();
    switch (mode) {
    case 0: return 0;
    case 1: return 17;
    case 2: return value % 64;
    case 3: return 0x1234567800000000ULL | (value & 0xffff);
    case 4: return 0x8000000000000000ULL | ((value % 4) << 32) | (next_random() % 10000);
    case 5: return ((value & 1) << 63) | ((next_random() % 1024) << 32) | (next_random() % 1500000);
    case 6: return value;
    default: return (uint64_t)(int64_t)((int32_t)(value % 4096) - 2048);
    }
}

static int check_parallel_seed_sort(void)
{
    for (int test = 0; test < 7; ++test) {
        const size_t n = (1U<<20) + (int[]){-1, 0, 1, 3, 5, 7, 9}[test];
        const int mode = (int[]){5, 4, 5, 4, 3, 1, 2}[test];
        mm128_t *candidate = malloc(n * sizeof(mm128_t));
        mm128_t *reference = malloc(n * sizeof(mm128_t));
        if (!candidate || !reference) return 21;
        for (size_t i = 0; i < n; ++i) {
            candidate[i].x = make_key(mode);
            candidate[i].y = ((uint64_t)i << 32) | (next_random() & 0xffffffffULL);
        }
        memcpy(reference, candidate, n * sizeof(mm128_t));
        test_cpu_count = test == 4 ? 1 : 2;
        test_create_failure = test == 3;
        const int before = test_create_calls;
        dnaforge_radix_sort_128x(candidate, candidate + n);
        radix_sort_reference128(reference, reference + n);
        if (memcmp(candidate, reference, n * sizeof(mm128_t))) {
            printf("{\"parallelCase\":%d,\"arrayByteExact\":false}\n", test);
            return 22;
        }
        if (test_create_calls - before != (test >= 1 && test <= 3)) return 23;
        free(candidate);
        free(reference);
    }
    if (test_create_calls != 3 || test_create_successes != 2) return 24;
    return 0;
}

static int check_inherited_constant_digits(void)
{
    const size_t n = 65536;
    mm128_t *candidate = malloc(n * sizeof(mm128_t));
    mm128_t *reference = malloc(n * sizeof(mm128_t));
    uint64_t *candidate64 = malloc(n * sizeof(uint64_t));
    uint64_t *reference64 = malloc(n * sizeof(uint64_t));
    if (!candidate || !reference || !candidate64 || !reference64) return 30;
    for (size_t i = 0; i < n; ++i) {
        candidate[i].x = ((uint64_t)(i / (n / 2)) << 63) | ((i % (n / 2)) / 128);
        candidate[i].y = next_random();
        candidate64[i] = candidate[i].x;
    }
    memcpy(reference, candidate, n * sizeof(mm128_t));
    memcpy(reference64, candidate64, n * sizeof(uint64_t));
    candidate_key_reads = reference_key_reads = 0;
    radix_sort_candidate128(candidate, candidate + n);
    radix_sort_reference128(reference, reference + n);
    if (memcmp(candidate, reference, n * sizeof(mm128_t))) return 31;
    if (candidate_key_reads > 4 * n + 16) return 32;
    candidate_key_reads = reference_key_reads = 0;
    radix_sort_candidate64(candidate64, candidate64 + n);
    radix_sort_reference64(reference64, reference64 + n);
    if (memcmp(candidate64, reference64, n * sizeof(uint64_t))) return 33;
    if (candidate_key_reads > 4 * n + 16) return 34;
    free(candidate);
    free(reference);
    free(candidate64);
    free(reference64);
    return 0;
}

int main(void)
{
    const size_t sizes[] = {0, 1, 2, 31, 63, 64, 65, 128, 511, 512, 4096, 65536};
    uint64_t cases = 0, values = 0, constant_candidate_reads = 0, constant_reference_reads = 0;
    for (int mode = 0; mode < 8; ++mode) {
        for (unsigned size = 0; size < sizeof(sizes) / sizeof(*sizes); ++size) {
            size_t n = sizes[size];
            mm128_t *candidate = malloc((n + 1) * sizeof(mm128_t));
            mm128_t *reference = malloc((n + 1) * sizeof(mm128_t));
            uint64_t *candidate64 = malloc((n + 1) * sizeof(uint64_t));
            uint64_t *reference64 = malloc((n + 1) * sizeof(uint64_t));
            if (!candidate || !reference || !candidate64 || !reference64) return 20;
            for (size_t i = 0; i < n; ++i) {
                candidate[i].x = make_key(mode);
                candidate[i].y = ((uint64_t)i << 32) | (next_random() & 0xffffffffULL);
                candidate64[i] = candidate[i].x;
            }
            memcpy(reference, candidate, n * sizeof(mm128_t));
            memcpy(reference64, candidate64, n * sizeof(uint64_t));
            candidate_key_reads = reference_key_reads = 0;
            radix_sort_candidate128(candidate, candidate + n);
            radix_sort_reference128(reference, reference + n);
            if (memcmp(candidate, reference, n * sizeof(mm128_t))) {
                printf("{\"mode\":%d,\"n\":%zu,\"pairArrayByteExact\":false}\n", mode, n);
                return 1;
            }
            if (mode <= 1 && n > 64) {
                if (candidate_key_reads > n * 2 || reference_key_reads <= candidate_key_reads) return 2;
                constant_candidate_reads += candidate_key_reads;
                constant_reference_reads += reference_key_reads;
            }
            candidate_key_reads = reference_key_reads = 0;
            radix_sort_candidate64(candidate64, candidate64 + n);
            radix_sort_reference64(reference64, reference64 + n);
            if (memcmp(candidate64, reference64, n * sizeof(uint64_t))) return 3;
            if (mode <= 1 && n > 64 && (candidate_key_reads > n * 2 || reference_key_reads <= candidate_key_reads)) return 4;
            free(candidate); free(reference); free(candidate64); free(reference64);
            ++cases; values += n;
        }
    }
    const int parallel_result = check_parallel_seed_sort();
    if (parallel_result) return parallel_result;
    const int inherited_result = check_inherited_constant_digits();
    if (inherited_result) return inherited_result;
    printf("{\"cases\":%llu,\"values\":%llu,\"parallelCases\":7,\"parallelAndFallbackArraysByteExact\":true,\"workerCreateCalls\":%d,\"workersCreated\":%d,\"completePairAnd64ArraysByteExact\":true,\"tiedKeyPayloadOrderExact\":true,\"constantKeysSinglePass\":true,\"inheritedPrefixCases\":2,\"inheritedConstantDigitPassesSkipped\":true,\"constantCandidateKeyReads\":%llu,\"constantReferenceKeyReads\":%llu,\"failures\":0}\n", (unsigned long long)cases, (unsigned long long)values, test_create_calls, test_create_successes, (unsigned long long)constant_candidate_reads, (unsigned long long)constant_reference_reads);
    return 0;
}
