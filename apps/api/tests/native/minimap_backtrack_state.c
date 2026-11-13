static uint64_t random_state = 0x8315bf6a7dc09e42ULL;
static uint64_t next_random(void)
{
    random_state ^= random_state << 13;
    random_state ^= random_state >> 7;
    random_state ^= random_state << 17;
    return random_state;
}

int main(void)
{
    const int sizes[] = {0, 1, 2, 8, 63, 64, 65, 512, 4096, 32768};
    const int minimum_scores[] = {-5, 0, 17, 100, INT32_MAX};
    const int maximum_drops[] = {-1, 0, 5, 50, INT32_MAX};
    uint64_t cases = 0, total_candidate = 0, total_reference = 0;
    for (int pooled = 0; pooled < 2; ++pooled) {
        for (int mode = 0; mode < 12; ++mode) {
            for (unsigned size = 0; size < sizeof(sizes) / sizeof(*sizes); ++size) {
                int n = sizes[size];
                size_t allocated = (size_t)(n ? n : 1);
                int32_t *f = malloc(allocated * sizeof(int32_t)), *saved_f = malloc(allocated * sizeof(int32_t));
                int64_t *parents = malloc(allocated * sizeof(int64_t)), *saved_p = malloc(allocated * sizeof(int64_t));
                int32_t *v[2] = {malloc(allocated * sizeof(int32_t)), malloc(allocated * sizeof(int32_t))};
                int32_t *t[2] = {malloc(allocated * sizeof(int32_t)), malloc(allocated * sizeof(int32_t))};
                if (!f || !saved_f || !parents || !saved_p || !v[0] || !v[1] || !t[0] || !t[1]) return 20;
                for (int i = 0; i < n; ++i) {
                    f[i] = mode % 4 == 0 ? 17 : mode % 4 == 1 ? i + 1 : (int32_t)(next_random() % 4000) - 1000;
                    parents[i] = i == 0 || mode % 4 == 0 ? -1 : mode % 4 == 1 ? i - 1 : (int64_t)(next_random() % i);
                    v[0][i] = v[1][i] = (int32_t)(next_random() & 0x7fffffff);
                    t[0][i] = t[1][i] = (int32_t)(next_random() % 3);
                }
                memcpy(saved_f, f, (size_t)n * sizeof(int32_t));
                memcpy(saved_p, parents, (size_t)n * sizeof(int64_t));
                int minimum_count = mode % 3 == 0 ? 1 : mode % 3 == 1 ? 2 : 10;
                int minimum_score = minimum_scores[mode % 5];
                int maximum_drop = maximum_drops[(mode / 2) % 5];
                int32_t n_u[2] = {0, 0}, n_v[2] = {0, 0};
                void *km = pooled ? km_init() : 0;
                candidate_walks = reference_walks = 0;
                uint64_t *u[2];
                u[0] = mg_chain_backtrack(km, n, f, parents, v[0], t[0], minimum_count, minimum_score, maximum_drop, &n_u[0], &n_v[0]);
                u[1] = dnaforge_reference_mg_chain_backtrack(km, n, f, parents, v[1], t[1], minimum_count, minimum_score, maximum_drop, &n_u[1], &n_v[1]);
                if (n_u[0] != n_u[1] || n_v[0] != n_v[1] || (n_u[0] && memcmp(u[0], u[1], (size_t)n_u[0] * sizeof(uint64_t))) || memcmp(v[0], v[1], (size_t)n * sizeof(int32_t)) || memcmp(t[0], t[1], (size_t)n * sizeof(int32_t))) {
                    printf("{\"mode\":%d,\"n\":%d,\"pooled\":%d,\"completeStateExact\":false}\n", mode, n, pooled);
                    return 1;
                }
                if (memcmp(f, saved_f, (size_t)n * sizeof(int32_t)) || memcmp(parents, saved_p, (size_t)n * sizeof(int64_t))) return 2;
                if (candidate_walks * 2 > reference_walks) return 3;
                total_candidate += candidate_walks; total_reference += reference_walks;
                for (int copy = 0; copy < 2; ++copy) { kfree(km, u[copy]); free(v[copy]); free(t[copy]); }
                if (km) km_destroy(km);
                free(f); free(saved_f); free(parents); free(saved_p);
                ++cases;
            }
        }
    }
    if (!total_candidate || total_candidate * 2 > total_reference) return 4;
    printf("{\"cases\":%llu,\"completeUvTStateExact\":true,\"inputFpUnchanged\":true,\"bothAllocatorModes\":true,\"walksAtMostHalfOriginal\":true,\"candidateWalks\":%llu,\"referenceWalks\":%llu,\"failures\":0}\n", (unsigned long long)cases, (unsigned long long)total_candidate, (unsigned long long)total_reference);
    return 0;
}
