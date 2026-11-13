#include <time.h>
#include <pthread.h>

typedef struct { uint64_t groups, anchors, cpu_ns, counts[10]; } dnaforge_profile_bin_t;
static dnaforge_profile_bin_t dnaforge_profile_bins[2][3][32];
static pthread_mutex_t dnaforge_profile_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t dnaforge_profile_once = PTHREAD_ONCE_INIT;
static const char *dnaforge_profile_path;
static uint64_t dnaforge_profile_cache[4];

static void dnaforge_profile_write(void)
{
    if (!dnaforge_profile_path) return;
    FILE *file = fopen(dnaforge_profile_path, "w");
    if (!file) abort();
    const char *classes[] = { "collinear-contiguous", "monotonic-query", "mixed-query" };
    const char *counters[] = { "packedAnchors", "eligibleAnchors", "coherentRuns", "isolatedRuns", "validRunDistances", "fastAnchors", "scoreCalls", "candidateVisits", "bucketPositions", "mergeSelections" };
    fprintf(file, "{\"schema\":\"dnaforge.chain-profile.v1\",\"diagnosticOnly\":true,\"samples\":[");
    int first = 1;
    for (int method = 0; method < 2; ++method)
        for (int kind = 0; kind < 3; ++kind)
            for (int size = 0; size < 32; ++size) {
                const dnaforge_profile_bin_t *bin = &dnaforge_profile_bins[method][kind][size];
                if (!bin->groups) continue;
                fprintf(file, "%s{\"method\":\"%s\",\"class\":\"%s\",\"sizeLog2\":%d,\"groups\":%llu,\"anchors\":%llu,\"cpuNs\":%llu",
                    first ? "" : ",", method ? "dp" : "rmq", classes[kind], size,
                    (unsigned long long)bin->groups, (unsigned long long)bin->anchors,
                    (unsigned long long)bin->cpu_ns);
                for (int counter = 0; counter < 10; ++counter)
                    fprintf(file, ",\"%s\":%llu", counters[counter], (unsigned long long)bin->counts[counter]);
                fprintf(file, "}");
                first = 0;
            }
    fprintf(file, "],\"cache\":{\"hits\":%llu,\"misses\":%llu,\"maxBufferBytes\":%llu,\"destroyedBuffers\":%llu}}\n",
        (unsigned long long)dnaforge_profile_cache[0], (unsigned long long)dnaforge_profile_cache[1],
        (unsigned long long)dnaforge_profile_cache[2], (unsigned long long)dnaforge_profile_cache[3]);
    if (fclose(file) != 0) abort();
}

static void dnaforge_profile_init(void)
{
    dnaforge_profile_path = getenv("DNA_NATIVE_CHAIN_PROFILE");
    if (dnaforge_profile_path && atexit(dnaforge_profile_write) != 0) abort();
}

static void dnaforge_chain_profile_cache_finish(uint64_t hits, uint64_t misses, uint64_t peak)
{
    pthread_once(&dnaforge_profile_once, dnaforge_profile_init);
    if (!dnaforge_profile_path) return;
    pthread_mutex_lock(&dnaforge_profile_mutex);
    dnaforge_profile_cache[0] += hits;
    dnaforge_profile_cache[1] += misses;
    if (dnaforge_profile_cache[2] < peak) dnaforge_profile_cache[2] = peak;
    ++dnaforge_profile_cache[3];
    pthread_mutex_unlock(&dnaforge_profile_mutex);
}

static void dnaforge_chain_profile_run(dnaforge_chain_work_t *work, int64_t begin, int64_t end, int method)
{
    pthread_once(&dnaforge_profile_once, dnaforge_profile_init);
    if (!dnaforge_profile_path) { work->score_range(work, begin, end); return; }
    const mm128_t *a = work->a;
    const int32_t span = begin < end ? a[begin].y >> 32 & 0xff : 0;
    int monotonic = 1, collinear = span > 0 && work->n_seg == 1 && !work->is_cdna
        && work->chn_pen_skip == 0.0f && work->chn_pen_gap >= 0.0f && work->bw >= 0
        && work->max_skip >= 0 && work->max_iter >= 1 && work->max_dist_x >= span
        && work->max_dist_y >= work->max_dist_x && begin < end && end <= INT32_MAX;
    for (int64_t i = begin; i < end; ++i) {
        if ((uint32_t)a[i].y > INT32_MAX || work->t[i] != 0) collinear = 0;
        if (i == begin) continue;
        const int64_t dx = (int64_t)(uint32_t)a[i].x - (uint32_t)a[i - 1].x;
        const int64_t dy = (int64_t)(uint32_t)a[i].y - (uint32_t)a[i - 1].y;
        if (dy <= 0) monotonic = 0;
        if (dx != dy || dx <= 0 || dx > span || a[i].x >> 32 != a[begin].x >> 32
            || a[i].y >> 32 != a[begin].y >> 32) collinear = 0;
    }
    if (begin < end && (int64_t)(uint32_t)a[end - 1].y - (uint32_t)a[begin].y + span > INT32_MAX)
        collinear = 0;
    int size = 0;
    for (uint64_t count = end - begin; count > 1 && size < 31; count >>= 1) ++size;
    struct timespec start, finish;
    uint64_t counts[10];
    memcpy(counts, dnaforge_chain_profile_counts, sizeof(counts));
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &start) != 0) abort();
    work->score_range(work, begin, end);
    if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &finish) != 0) abort();
    const uint64_t elapsed = (uint64_t)(finish.tv_sec - start.tv_sec) * 1000000000ULL + finish.tv_nsec - start.tv_nsec;
    pthread_mutex_lock(&dnaforge_profile_mutex);
    dnaforge_profile_bin_t *bin = &dnaforge_profile_bins[method][collinear ? 0 : monotonic ? 1 : 2][size];
    ++bin->groups;
    bin->anchors += end - begin;
    bin->cpu_ns += elapsed;
    for (int counter = 0; counter < 10; ++counter)
        bin->counts[counter] += dnaforge_chain_profile_counts[counter] - counts[counter];
    pthread_mutex_unlock(&dnaforge_profile_mutex);
}
