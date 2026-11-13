#include <stdint.h>
#include <float.h>
#include <string.h>
#include <stdio.h>
#include <assert.h>
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>
#include "mmpriv.h"
#include "kalloc.h"
#include "krmq.h"

static int64_t mg_chain_bk_end(int32_t max_drop, const mm128_t *z, const int32_t *f, const int64_t *p, int32_t *t, int64_t k)
{
	int64_t i = z[k].y, end_i = -1, max_i = i;
	int32_t max_s = 0;
	if (i < 0 || t[i] != 0) return i;
	do {
		int32_t s;
		t[i] = 2;
		end_i = i = p[i];
		s = i < 0? z[k].x : (int32_t)z[k].x - f[i];
		if (s > max_s) max_s = s, max_i = i;
		else if (max_s - s > max_drop) break;
	} while (i >= 0 && t[i] == 0);
	for (i = z[k].y; i >= 0 && i != end_i; i = p[i]) // reset modified t[]
		t[i] = 0;
	return max_i;
}

uint64_t *mg_chain_backtrack(void *km, int64_t n, const int32_t *f, const int64_t *p, int32_t *v, int32_t *t, int32_t min_cnt, int32_t min_sc, int32_t max_drop, int32_t *n_u_, int32_t *n_v_)
{
    mm128_t *z;
    uint64_t *u;
    int64_t i, k, n_z, n_v;
    int32_t n_u;

    *n_u_ = *n_v_ = 0;
    for (i = 0, n_z = 0; i < n; ++i)
        if (f[i] >= min_sc) ++n_z;
    if (n_z == 0) return 0;
    z = Kmalloc(km, mm128_t, n_z);
    for (i = 0, k = 0; i < n; ++i)
        if (f[i] >= min_sc) z[k].x = f[i], z[k++].y = i;
    radix_sort_128x(z, z + n_z);

    memset(t, 0, n * 4);
    for (k = n_z - 1, n_v = n_u = 0; k >= 0; --k) {
        if (t[z[k].y] == 0) {
            int64_t n_v0 = n_v, end_i;
            int32_t sc;
            end_i = mg_chain_bk_end(max_drop, z, f, p, t, k);
            for (i = z[k].y; i != end_i; i = p[i])
                v[n_v++] = i, t[i] = 1;
            sc = i < 0 ? z[k].x : (int32_t)z[k].x - f[i];
            if (sc >= min_sc && n_v > n_v0 && n_v - n_v0 >= min_cnt) {
                z[n_z - 1 - n_u].x = (uint64_t)sc << 32 | (n_v - n_v0);
                ++n_u;
            } else n_v = n_v0;
        }
    }
    u = Kmalloc(km, uint64_t, n_u);
    for (i = 0; i < n_u; ++i) u[i] = z[n_z - 1 - i].x;
    kfree(km, z);
    assert(n_v < INT32_MAX);
    *n_u_ = n_u, *n_v_ = n_v;
    return u;
}

static mm128_t *compact_a(void *km, int32_t n_u, uint64_t *u, int32_t n_v, int32_t *v, mm128_t *a)
{
	mm128_t *b, *w;
	uint64_t *u2;
	int64_t i, j, k;

	// write the result to b[]
	b = Kmalloc(km, mm128_t, n_v);
	for (i = 0, k = 0; i < n_u; ++i) {
		int32_t k0 = k, ni = (int32_t)u[i];
		for (j = 0; j < ni; ++j)
			b[k++] = a[v[k0 + (ni - j - 1)]];
	}
	kfree(km, v);

	// sort u[] and a[] by the target position, such that adjacent chains may be joined
	w = Kmalloc(km, mm128_t, n_u);
	for (i = k = 0; i < n_u; ++i) {
		w[i].x = b[k].x, w[i].y = (uint64_t)k<<32|i;
		k += (int32_t)u[i];
	}
	radix_sort_128x(w, w + n_u);
	u2 = Kmalloc(km, uint64_t, n_u);
	for (i = k = 0; i < n_u; ++i) {
		int32_t j = (int32_t)w[i].y, n = (int32_t)u[j];
		u2[i] = u[j];
		memcpy(&a[k], &b[w[i].y>>32], n * sizeof(mm128_t));
		k += n;
	}
	memcpy(u, u2, n_u * 8);
	memcpy(b, a, k * sizeof(mm128_t)); // write _a_ to _b_ and deallocate _a_ because _a_ is oversized, sometimes a lot
	kfree(km, a); kfree(km, w); kfree(km, u2);
	return b;
}

static inline int32_t comput_sc(const mm128_t *ai, const mm128_t *aj, int32_t max_dist_x, int32_t max_dist_y, int32_t bw, float chn_pen_gap, float chn_pen_skip, int is_cdna, int n_seg)
{
	int32_t dq = (int32_t)ai->y - (int32_t)aj->y, dr, dd, dg, q_span, sc;
	int32_t sidi = (ai->y & MM_SEED_SEG_MASK) >> MM_SEED_SEG_SHIFT;
	int32_t sidj = (aj->y & MM_SEED_SEG_MASK) >> MM_SEED_SEG_SHIFT;
	if (dq <= 0 || dq > max_dist_x) return INT32_MIN;
	dr = (int32_t)(ai->x - aj->x);
	if (sidi == sidj && (dr == 0 || dq > max_dist_y)) return INT32_MIN;
	dd = dr > dq? dr - dq : dq - dr;
	if (sidi == sidj && dd > bw) return INT32_MIN;
	if (n_seg > 1 && !is_cdna && sidi == sidj && dr > max_dist_y) return INT32_MIN;
	dg = dr < dq? dr : dq;
	q_span = aj->y>>32&0xff;
	sc = q_span < dg? q_span : dg;
	if (dd || dg > q_span) {
		float lin_pen, log_pen;
		lin_pen = chn_pen_gap * (float)dd + chn_pen_skip * (float)dg;
		log_pen = dd >= 1? mg_log2(dd + 1) : 0.0f; // mg_log2() only works for dd>=2
		if (is_cdna || sidi != sidj) {
			if (sidi != sidj && dr == 0) ++sc; // possibly due to overlapping paired ends; give a minor bonus
			else if (dr > dq || sidi != sidj) sc -= (int)(lin_pen < log_pen? lin_pen : log_pen); // deletion or jump between paired ends
			else sc -= (int)(lin_pen + .5f * log_pen);
		} else sc -= (int)(lin_pen + .5f * log_pen);
	}
	return sc;
}

static inline int32_t dnaforge_comput_cached_sc(const mm128_t *ai, const mm128_t *aj, int32_t max_dist_x, int32_t max_dist_y, int32_t bw, float chn_pen_gap, float chn_pen_skip, int is_cdna, int n_seg, const int32_t *penalties) __attribute__((always_inline));

static inline int32_t dnaforge_comput_cached_sc(const mm128_t *ai, const mm128_t *aj, int32_t max_dist_x, int32_t max_dist_y, int32_t bw, float chn_pen_gap, float chn_pen_skip, int is_cdna, int n_seg, const int32_t *penalties)
{
    int32_t dq = (int32_t)ai->y - (int32_t)aj->y;
    if (dq <= 0 || dq > max_dist_x) return INT32_MIN;
    if (!penalties || ((ai->y ^ aj->y) & MM_SEED_SEG_MASK))
        return comput_sc(ai, aj, max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg);
    int32_t dr = (int32_t)(ai->x - aj->x);
    if (dr < 0)
        return comput_sc(ai, aj, max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg);
    if (dr == 0 || dq > max_dist_y) return INT32_MIN;
    int32_t dd = dr > dq ? dr - dq : dq - dr;
    if (dd > bw) return INT32_MIN;
    int32_t dg = dr < dq ? dr : dq;
    int32_t q_span = aj->y >> 32 & 0xff;
    return (q_span < dg ? q_span : dg) - penalties[dd];
}

typedef struct dnaforge_chain_work_s {
    const mm128_t *a;
    int32_t *f, *t, *v;
    int64_t *p;
    int max_dist_x, max_dist_y, bw, max_skip, max_iter, is_cdna, n_seg;
    float chn_pen_gap, chn_pen_skip;
    int64_t *bounds, groups, count;
    int64_t *reuse_from;
    int max_dist_inner, cap_rmq_size;
    void (*score_range)(struct dnaforge_chain_work_s *, int64_t, int64_t);
    int32_t *penalties;
    int coherent_runs;
    void *arena;
    dnaforge_chain_cache_t *cache;
} dnaforge_chain_work_t;

typedef struct {
    dnaforge_chain_work_t *work;
    int64_t next_group;
} dnaforge_chain_schedule_t;

static int32_t *dnaforge_prepare_chain_penalties(const dnaforge_chain_work_t *work)
{
    if (work->is_cdna || work->n_seg != 1 || work->chn_pen_skip != 0.0f || work->bw < 0 || work->bw > 32768 || !(work->chn_pen_gap >= 0.0f) || !(work->chn_pen_gap <= (float)INT32_MAX) || (double)work->chn_pen_gap * work->bw > INT32_MAX / 4)
        return 0;
    int32_t *penalties = (int32_t *)malloc(((size_t)work->bw + 1) * sizeof(int32_t));
    if (!penalties) return 0;
    mm128_t previous = { .x = 0, .y = (1ULL << 32) | 1 };
    mm128_t current = { .x = 1, .y = 2 };
    for (int32_t distance = 0; distance <= work->bw; ++distance) {
        current.x = (uint32_t)distance + 1;
        penalties[distance] = 1 - comput_sc(&current, &previous, INT32_MAX, INT32_MAX, work->bw, work->chn_pen_gap, 0.0f, 0, 1);
    }
    return penalties;
}

static inline int32_t dnaforge_chain_peak_at(const int32_t *f, const int64_t *p, const int32_t *v, int64_t i)
{
    return p[i] >= 0 && v[p[i]] > f[i] ? v[p[i]] : f[i];
}

static void dnaforge_chain_materialize_peaks(int64_t begin, int64_t end, const int32_t *f, const int64_t *p, int32_t *v)
{
    for (int64_t i = begin; i < end; ++i) v[i] = dnaforge_chain_peak_at(f, p, v, i);
}

static void dnaforge_chain_score_range_original(dnaforge_chain_work_t *work, int64_t begin, int64_t end)
{
    const mm128_t *a = work->a;
    int32_t *f = work->f, *t = work->t, *v = work->v, mmax_f = 0;
    int64_t *p = work->p, i, j, max_ii, st = begin;
    const int max_dist_x = work->max_dist_x, max_dist_y = work->max_dist_y;
    const int bw = work->bw, max_skip = work->max_skip, max_iter = work->max_iter;
    const int is_cdna = work->is_cdna, n_seg = work->n_seg;
    const float chn_pen_gap = work->chn_pen_gap, chn_pen_skip = work->chn_pen_skip;
	for (i = begin, max_ii = -1; i < end; ++i) {
		int64_t max_j = -1, end_j;
		int32_t max_f = a[i].y>>32&0xff, n_skip = 0;
		while (st < i && (a[i].x>>32 != a[st].x>>32 || a[i].x > a[st].x + max_dist_x)) ++st;
		if (i - st > max_iter) st = i - max_iter;
		for (j = i - 1; j >= st; --j) {
			int32_t sc;
			sc = comput_sc(&a[i], &a[j], max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg);
			if (sc == INT32_MIN) continue;
			sc += f[j];
			if (sc > max_f) {
				max_f = sc, max_j = j;
				if (n_skip > 0) --n_skip;
			} else if (t[j] == (int32_t)i) {
				if (++n_skip > max_skip)
					break;
			}
			if (p[j] >= 0) t[p[j]] = i;
		}
		end_j = j;
		if (max_ii < 0 || a[i].x - a[max_ii].x > (int64_t)max_dist_x) {
			int32_t max = INT32_MIN;
			max_ii = -1;
			for (j = i - 1; j >= st; --j)
				if (max < f[j]) max = f[j], max_ii = j;
		}
		if (max_ii >= 0 && max_ii < end_j) {
			int32_t tmp;
			tmp = comput_sc(&a[i], &a[max_ii], max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg);
			if (tmp != INT32_MIN && max_f < tmp + f[max_ii])
				max_f = tmp + f[max_ii], max_j = max_ii;
		}
		f[i] = max_f, p[i] = max_j;
        if (v) v[i] = max_j >= 0 && v[max_j] > max_f ? v[max_j] : max_f;
		if (max_ii < 0 || (a[i].x - a[max_ii].x <= (int64_t)max_dist_x && f[max_ii] < f[i]))
			max_ii = i;
		if (mmax_f < max_f) mmax_f = max_f;
		//fprintf(stderr, "X1\t%ld\t%ld:%d\t%ld\t%ld:%d\t%ld\t%ld\n", (long)i, (long)(a[i].x>>32), (int32_t)a[i].x, (long)max_j, max_j<0?-1L:(long)(a[max_j].x>>32), max_j<0?-1:(int32_t)a[max_j].x, (long)max_f, (long)v[i]);
	}

}

static void dnaforge_chain_score_range_cached(dnaforge_chain_work_t *work, int64_t begin, int64_t end)
{
    const mm128_t *a = work->a;
    int32_t *f = work->f, *t = work->t, *v = work->v, mmax_f = 0;
    int64_t *p = work->p, i, j, max_ii, st = begin;
    const int max_dist_x = work->max_dist_x, max_dist_y = work->max_dist_y;
    const int bw = work->bw, max_skip = work->max_skip, max_iter = work->max_iter;
    const int is_cdna = work->is_cdna, n_seg = work->n_seg;
    const float chn_pen_gap = work->chn_pen_gap, chn_pen_skip = work->chn_pen_skip;
    const int32_t *penalties = work->penalties;
	for (i = begin, max_ii = -1; i < end; ++i) {
		int64_t max_j = -1, end_j;
		int32_t max_f = a[i].y>>32&0xff, n_skip = 0;
		while (st < i && (a[i].x>>32 != a[st].x>>32 || a[i].x > a[st].x + max_dist_x)) ++st;
		if (i - st > max_iter) st = i - max_iter;
		for (j = i - 1; j >= st; --j) {
			int32_t sc;
			sc = dnaforge_comput_cached_sc(&a[i], &a[j], max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg, penalties);
			if (sc == INT32_MIN) continue;
			sc += f[j];
			if (sc > max_f) {
				max_f = sc, max_j = j;
				if (n_skip > 0) --n_skip;
			} else if (t[j] == (int32_t)i) {
				if (++n_skip > max_skip)
					break;
			}
			if (p[j] >= 0) t[p[j]] = i;
		}
		end_j = j;
		if (max_ii < 0 || a[i].x - a[max_ii].x > (int64_t)max_dist_x) {
			int32_t max = INT32_MIN;
			max_ii = -1;
			for (j = i - 1; j >= st; --j)
				if (max < f[j]) max = f[j], max_ii = j;
		}
		if (max_ii >= 0 && max_ii < end_j) {
			int32_t tmp;
			tmp = dnaforge_comput_cached_sc(&a[i], &a[max_ii], max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg, penalties);
			if (tmp != INT32_MIN && max_f < tmp + f[max_ii])
				max_f = tmp + f[max_ii], max_j = max_ii;
		}
		f[i] = max_f, p[i] = max_j;
        if (v) v[i] = dnaforge_chain_peak_at(f, p, v, i);
		if (max_ii < 0 || (a[i].x - a[max_ii].x <= (int64_t)max_dist_x && f[max_ii] < f[i]))
			max_ii = i;
		if (mmax_f < max_f) mmax_f = max_f;
		//fprintf(stderr, "X1\t%ld\t%ld:%d\t%ld\t%ld:%d\t%ld\t%ld\n", (long)i, (long)(a[i].x>>32), (int32_t)a[i].x, (long)max_j, max_j<0?-1L:(long)(a[max_j].x>>32), max_j<0?-1:(int32_t)a[max_j].x, (long)max_f, (long)v[i]);
	}

}

static void dnaforge_chain_score_range_scalar(dnaforge_chain_work_t *work, int64_t begin, int64_t end)
{
    if (work->penalties) dnaforge_chain_score_range_cached(work, begin, end);
    else dnaforge_chain_score_range_original(work, begin, end);
}

static int dnaforge_chain_diagonal_bins(int max_dist_x, int bw, int64_t query_bins, int64_t count, int *diagonal_bits)
{
    if (max_dist_x < 1 || bw < 0 || query_bins < 1 || count < 1) return 0;
    *diagonal_bits = 0;
    while ((1ULL << *diagonal_bits) < (uint64_t)bw * 2 + 1) ++*diagonal_bits;
    uint64_t slots = (uint64_t)count * 4;
    if (slots > SIZE_MAX / sizeof(int64_t)) slots = SIZE_MAX / sizeof(int64_t);
    if ((uint64_t)query_bins > slots) return 0;
    const uint64_t capacity = slots / (uint64_t)query_bins;
    const uint64_t span = (uint64_t)max_dist_x * 2 + (uint64_t)bw * 2;
    int diagonal_bins = 1;
    while (diagonal_bins <= INT32_MAX / 2 &&
           (uint64_t)diagonal_bins * 2 <= capacity &&
           ((uint64_t)diagonal_bins << *diagonal_bits) <= span)
        diagonal_bins *= 2;
    return diagonal_bins;
}

static inline int dnaforge_chain_diagonal_in_band(int64_t current, int64_t previous, int bw)
{
    const int64_t difference = current - previous;
    return difference >= -(int64_t)bw && difference <= bw;
}

typedef struct {
    int32_t predecessor, score;
    uint32_t fast;
} dnaforge_chain_anchor_t;

typedef struct {
    int32_t index;
    uint32_t target, query_span;
} dnaforge_chain_entry_t;

typedef struct {
    uint32_t begin, cursor;
} dnaforge_chain_bucket_t;
typedef struct { int64_t position; uint32_t begin; int32_t index; } dnaforge_chain_cursor_t;

_Static_assert(sizeof(dnaforge_chain_anchor_t) + sizeof(dnaforge_chain_entry_t) == 24, "Packed candidate state must remain bounded.");
_Static_assert(sizeof(dnaforge_chain_bucket_t) == 8, "Candidate bucket storage must remain bounded.");

static inline int32_t dnaforge_chain_anchor_query(const dnaforge_chain_entry_t *anchor)
{
    return anchor->query_span & 0x00ffffffu;
}

static inline __attribute__((always_inline)) int32_t dnaforge_chain_anchor_score(const dnaforge_chain_work_t *work, const dnaforge_chain_entry_t *current, const dnaforge_chain_entry_t *previous)
{
    const mm128_t ai = { .x = current->target, .y = ((uint64_t)(current->query_span >> 24) << 32) | (uint32_t)dnaforge_chain_anchor_query(current) };
    const mm128_t aj = { .x = previous->target, .y = ((uint64_t)(previous->query_span >> 24) << 32) | (uint32_t)dnaforge_chain_anchor_query(previous) };
    return dnaforge_comput_cached_sc(&ai, &aj, work->max_dist_x, work->max_dist_y, work->bw, work->chn_pen_gap, work->chn_pen_skip, work->is_cdna, work->n_seg, work->penalties);
}

static inline __attribute__((always_inline)) int32_t dnaforge_chain_validated_score(int32_t span, int32_t query_distance, int32_t target_distance, int32_t diagonal_distance, const int32_t *penalties)
{
    const int32_t distance = target_distance < query_distance ? target_distance : query_distance;
    return (span < distance ? span : distance) - penalties[diagonal_distance];
}

static inline dnaforge_chain_entry_t dnaforge_chain_entry(const mm128_t *anchor, int32_t index)
{
    const dnaforge_chain_entry_t entry = { .index = index, .target = (uint32_t)anchor->x,
        .query_span = (uint32_t)anchor->y | ((uint32_t)(uint8_t)(anchor->y >> 32) << 24) };
    return entry;
}

static inline int64_t dnaforge_chain_entry_bucket(const dnaforge_chain_entry_t *entry, int32_t query_origin, int max_dist_x, int diagonal_bins, int diagonal_bits)
{
    const int32_t query = dnaforge_chain_anchor_query(entry);
    const int64_t diagonal = (int64_t)entry->target - query;
    return (int64_t)((query - query_origin) / max_dist_x) * diagonal_bins
        + (((uint64_t)diagonal >> diagonal_bits) & (diagonal_bins - 1));
}

static inline dnaforge_chain_cursor_t dnaforge_chain_bucket_cursor(const dnaforge_chain_bucket_t *bucket, const dnaforge_chain_entry_t *entries)
{
    const uint32_t begin = bucket->begin;
    const int64_t position = (int64_t)bucket->cursor - 1;
    const dnaforge_chain_cursor_t cursor = { .position = position, .begin = begin,
        .index = position >= begin ? entries[position].index : -1 };
    return cursor;
}

static int32_t dnaforge_chain_query_origin(const mm128_t *a, int64_t begin, int64_t end)
{
    int32_t origin = begin < end ? (int32_t)a[begin].y : 0;
    for (int64_t i = begin; i < end; ++i)
        if (origin > (int32_t)a[i].y) origin = (int32_t)a[i].y;
    return origin;
}

typedef struct {
    int32_t predecessor, score, bucket_previous;
    uint32_t fast;
} dnaforge_chain_dense_node_t;

typedef struct {
    int32_t head;
    uint32_t count;
    int32_t recent[27];
} dnaforge_chain_dense_bucket_t;

_Static_assert(sizeof(dnaforge_chain_dense_node_t) == 16, "Dense candidate state must remain bounded.");

static inline void dnaforge_chain_dense_insert(dnaforge_chain_dense_bucket_t *bucket, dnaforge_chain_dense_node_t *node, int32_t index)
{
    node->bucket_previous = bucket->head;
    bucket->recent[bucket->count % 27] = index;
    ++bucket->count;
    bucket->head = index;
}

static int dnaforge_chain_score_range_dense(dnaforge_chain_work_t *work, int64_t begin, int64_t end, int32_t query_origin,
    int diagonal_bins, int diagonal_bits, int64_t head_count, int fast_enabled)
{
    const int64_t count = end - begin;
    if ((uint64_t)head_count > (uint64_t)count * 8 / sizeof(dnaforge_chain_dense_bucket_t)) return 0;
    dnaforge_chain_dense_node_t *nodes = (dnaforge_chain_dense_node_t *)malloc((size_t)count * sizeof(*nodes));
    dnaforge_chain_dense_bucket_t *heads = (dnaforge_chain_dense_bucket_t *)malloc((size_t)head_count * sizeof(*heads));
    if (!nodes || !heads) { free(nodes); free(heads); return 0; }
    for (int64_t slot = 0; slot < head_count; ++slot) { heads[slot].head = -1; heads[slot].count = 0; }
    const int max_dist_x = work->max_dist_x, max_dist_y = work->max_dist_y, bw = work->bw;
    const int32_t *penalties = work->penalties;
    const int64_t stop = (int64_t)work->max_skip + 2;
    const int diagonal_bin_shift = __builtin_ctz((unsigned)diagonal_bins);
    int32_t *tags = work->t + begin;
    fast_enabled = fast_enabled && stop <= 27;
    int64_t st = 0, max_ii = -1, last_slot = 0;
    int has_fast = 0;
    for (int64_t i = 0; i < count; ++i) {
        const dnaforge_chain_entry_t current = dnaforge_chain_entry(&work->a[begin + i], (int32_t)i);
        if (i > 0) dnaforge_chain_dense_insert(&heads[last_slot], &nodes[i - 1], (int32_t)(i - 1));
        nodes[i].fast = 0;
        nodes[i].bucket_previous = -1;
        while (st < i && (uint64_t)current.target > (uint64_t)(uint32_t)work->a[begin + st].x + max_dist_x) ++st;
        if (i - st > work->max_iter) st = i - work->max_iter;
        const int32_t query = dnaforge_chain_anchor_query(&current);
        const int64_t slot = dnaforge_chain_entry_bucket(&current, query_origin, max_dist_x, diagonal_bins, diagonal_bits);
        const int64_t current_bin = slot >> diagonal_bin_shift;
        last_slot = slot;
        dnaforge_chain_dense_bucket_t *bucket = &heads[slot];
        const int32_t previous_index = bucket->head;
        const int64_t current_diagonal = (int64_t)current.target - query;
        const int32_t low = query > max_dist_x ? query - max_dist_x : 0;
        int32_t candidates[4] = { -1, -1, -1, -1 };
        if (query > query_origin) {
            const int64_t low_bin = current_bin > 0 ? current_bin - 1 : 0;
            const int64_t high_bin = current_bin - ((int64_t)query - query_origin == current_bin * max_dist_x);
            const int low_diagonal = ((uint64_t)(current_diagonal - bw) >> diagonal_bits) & (diagonal_bins - 1);
            const int high_diagonal = ((uint64_t)(current_diagonal + bw) >> diagonal_bits) & (diagonal_bins - 1);
            candidates[0] = heads[low_bin * diagonal_bins + low_diagonal].head;
            if (high_diagonal != low_diagonal) candidates[2] = heads[low_bin * diagonal_bins + high_diagonal].head;
            if (high_bin != low_bin) {
                candidates[1] = heads[high_bin * diagonal_bins + low_diagonal].head;
                if (high_diagonal != low_diagonal) candidates[3] = heads[high_bin * diagonal_bins + high_diagonal].head;
            }
        }
        int64_t j = -1, max_j = -1, end_j;
        int32_t max_f = current.query_span >> 24, n_skip = 0;
        int shortcut = 0;
        if (fast_enabled && previous_index >= 0 && (nodes[previous_index].fast & 0x7fffffffu) >= stop) {
            const dnaforge_chain_entry_t previous = dnaforge_chain_entry(&work->a[begin + previous_index], previous_index);
            const int32_t stopping = bucket->recent[(bucket->count - (uint32_t)stop) % 27];
            const int64_t delta = (int64_t)query - dnaforge_chain_anchor_query(&previous);
            const int64_t score = (int64_t)nodes[previous_index].score + delta;
            const int64_t distance = (int64_t)current.target - (uint32_t)work->a[begin + stopping].x;
            int own_head = 0, isolated = 1;
            for (int cursor = 0; cursor < 4; ++cursor) {
                if (candidates[cursor] == previous_index) own_head = 1;
                else if (candidates[cursor] >= stopping) isolated = 0;
            }
            shortcut = own_head && isolated && stopping >= st
                && delta > 0 && delta == (int64_t)current.target - previous.target
                && delta <= (previous.query_span >> 24) && score > max_f && score <= INT32_MAX
                && distance >= 0 && distance <= max_dist_x && distance <= max_dist_y;
            if (shortcut) {
                max_f = (int32_t)score;
                max_j = previous_index;
                j = stopping;
                nodes[i].fast = 0x80000000u;
                has_fast = 1;
            }
        }
        if (!shortcut) for (;;) {
            const int left_head = candidates[0] >= candidates[1] ? 0 : 1;
            const int right_head = candidates[2] >= candidates[3] ? 2 : 3;
            const int selected = candidates[left_head] >= candidates[right_head] ? left_head : right_head;
            const int competing = selected < 2 ? right_head : left_head;
            const int32_t boundary = candidates[competing] >= candidates[selected ^ 1]
                ? candidates[competing] : candidates[selected ^ 1];
            do {
                j = candidates[selected];
                if (j < st) { j = st - 1; goto dnaforge_dense_candidates_done; }
                candidates[selected] = nodes[j].bucket_previous;
                const dnaforge_chain_entry_t previous = dnaforge_chain_entry(&work->a[begin + j], (int32_t)j);
                const int32_t previous_query = dnaforge_chain_anchor_query(&previous);
                if (previous_query < low || previous_query >= query) continue;
                const int32_t query_distance = query - previous_query;
                const int32_t target_distance = (int32_t)(current.target - previous.target);
                if (target_distance == 0 || query_distance > max_dist_y) continue;
                const int64_t difference = current_diagonal - ((int64_t)previous.target - previous_query);
                if (difference < -(int64_t)bw || difference > bw) continue;
                int32_t score = dnaforge_chain_validated_score(previous.query_span >> 24, query_distance, target_distance,
                    (int32_t)(difference < 0 ? -difference : difference), penalties) + nodes[j].score;
                if (score > max_f) {
                    max_f = score; max_j = j;
                    if (n_skip > 0) --n_skip;
                } else if (tags[j] == (int32_t)(begin + i)) {
                    if (++n_skip > work->max_skip) goto dnaforge_dense_candidates_done;
                }
                if (nodes[j].predecessor >= 0) tags[nodes[j].predecessor] = (int32_t)(begin + i);
            } while (candidates[selected] > boundary);
        }
        dnaforge_dense_candidates_done:
        end_j = j;
        if (max_ii < 0 || (uint64_t)current.target - (uint32_t)work->a[begin + max_ii].x > (int64_t)max_dist_x) {
            int32_t maximum = INT32_MIN;
            max_ii = -1;
            for (j = i - 1; j >= st; --j)
                if (maximum < nodes[j].score) { maximum = nodes[j].score; max_ii = j; }
        }
        if (max_ii >= 0 && max_ii < end_j) {
            const dnaforge_chain_entry_t previous = dnaforge_chain_entry(&work->a[begin + max_ii], (int32_t)max_ii);
            const int32_t score = dnaforge_chain_anchor_score(work, &current, &previous);
            if (score != INT32_MIN && max_f < score + nodes[max_ii].score) {
                max_f = score + nodes[max_ii].score; max_j = max_ii;
            }
        }
        nodes[i].score = max_f;
        nodes[i].predecessor = max_j;
        if (max_ii < 0 || ((uint64_t)current.target - (uint32_t)work->a[begin + max_ii].x <= (int64_t)max_dist_x && nodes[max_ii].score < max_f)) max_ii = i;
        if (fast_enabled) {
            uint32_t run_length = 1;
            if (previous_index >= 0) {
                const dnaforge_chain_entry_t previous = dnaforge_chain_entry(&work->a[begin + previous_index], previous_index);
                const int64_t delta = (int64_t)query - dnaforge_chain_anchor_query(&previous);
                if (max_j == previous_index && delta > 0 && delta == (int64_t)current.target - previous.target
                    && (int64_t)max_f == (int64_t)nodes[previous_index].score + delta)
                    run_length += nodes[previous_index].fast & 0x7fffffffu;
            }
            nodes[i].fast |= run_length;
        }
    }
    if (has_fast) {
        dnaforge_chain_dense_insert(&heads[last_slot], &nodes[count - 1], (int32_t)(count - 1));
        for (int64_t slot = 0; slot < head_count; ++slot) {
            int32_t writers[27];
            int64_t positions[27], position = 0;
            unsigned first = 0, size = 0;
            int32_t newer = -1, twice_newer = -1;
            for (int32_t at = heads[slot].head; at >= 0; at = nodes[at].bucket_previous, ++position) {
                while (size && positions[first] + stop < position) { first = (first + 1) % 27; --size; }
                if (twice_newer >= 0 && (nodes[twice_newer].fast & 0x80000000u)) {
                    const unsigned next = (first + size) % 27;
                    writers[next] = twice_newer;
                    positions[next] = position - 2;
                    ++size;
                }
                if (size) {
                    const int32_t writer = (int32_t)(begin + writers[first]);
                    if (tags[at] < writer) tags[at] = writer;
                }
                twice_newer = newer;
                newer = at;
            }
        }
    }
    for (int64_t i = 0; i < count; ++i) {
        work->f[begin + i] = nodes[i].score;
        work->p[begin + i] = nodes[i].predecessor < 0 ? -1 : begin + nodes[i].predecessor;
    }
    if (work->v) dnaforge_chain_materialize_peaks(begin, end, work->f, work->p, work->v);
    free(heads); free(nodes);
    return 1;
}

static int dnaforge_chain_score_range_packed(dnaforge_chain_work_t *work, int64_t begin, int64_t end, int32_t maximum_query_coordinate)
{
    const int64_t count = end - begin;
    if (!work->penalties || count < 512 || count > INT32_MAX || maximum_query_coordinate < 0 || maximum_query_coordinate > 0x00ffffff || work->max_dist_x < 1 || (uint64_t)count > SIZE_MAX / (sizeof(dnaforge_chain_anchor_t) + sizeof(dnaforge_chain_entry_t))) return 0;
    const uint64_t target_group = work->a[begin].x >> 32;
    const uint64_t segment = work->a[begin].y & MM_SEED_SEG_MASK;
    int initial_tags_zero = 1;
    for (int64_t i = begin; i < end; ++i) {
        if (work->a[i].x >> 32 != target_group || (work->a[i].y & MM_SEED_SEG_MASK) != segment || (uint32_t)work->a[i].y > 0x00ffffffu) return 0;
        if (work->t[i] != 0) initial_tags_zero = 0;
    }

    const int max_dist_x = work->max_dist_x, max_dist_y = work->max_dist_y, bw = work->bw;
    const int32_t *penalties = work->penalties;
    const int64_t stop = (int64_t)work->max_skip + 2;
    int fast_enabled = initial_tags_zero && work->coherent_runs && begin >= 0 && end <= INT32_MAX
        && work->max_skip >= 0 && work->max_iter >= stop && stop < count && work->max_dist_y > 0;
    int32_t *tags = work->t + begin;
    const int32_t query_origin = dnaforge_chain_query_origin(work->a, begin, end);
    const int64_t bins = ((int64_t)maximum_query_coordinate - query_origin) / max_dist_x + 1;
    if ((uint64_t)bins > (uint64_t)count * 4) return 0;
    int diagonal_bits = 0;
    const int diagonal_bins = dnaforge_chain_diagonal_bins(max_dist_x, bw, bins, count, &diagonal_bits);
    if (!diagonal_bins) return 0;
    const int64_t head_count = bins * diagonal_bins;
    if (dnaforge_chain_score_range_dense(work, begin, end, query_origin, diagonal_bins, diagonal_bits, head_count, fast_enabled)) return 1;
    const int reuse_bucket_positions = head_count <= UINT32_MAX;
    const int diagonal_bin_shift = __builtin_ctz((unsigned)diagonal_bins);
    dnaforge_chain_bucket_t *buckets = (dnaforge_chain_bucket_t *)calloc((size_t)head_count, sizeof(dnaforge_chain_bucket_t));
    dnaforge_chain_anchor_t *state = (dnaforge_chain_anchor_t *)malloc((size_t)count * sizeof(dnaforge_chain_anchor_t));
    dnaforge_chain_entry_t *entries = (dnaforge_chain_entry_t *)malloc((size_t)count * sizeof(dnaforge_chain_entry_t));
    if (!buckets || !state || !entries) { free(buckets); free(state); free(entries); return 0; }
    for (int64_t i = 0; i < count; ++i) {
        const dnaforge_chain_entry_t entry = dnaforge_chain_entry(&work->a[begin + i], (int32_t)i);
        const int64_t slot = dnaforge_chain_entry_bucket(&entry, query_origin, max_dist_x, diagonal_bins, diagonal_bits);
        ++buckets[slot].cursor;
        if (reuse_bucket_positions) state[i].fast = (uint32_t)slot;
    }
    for (int64_t slot = 0, offset = 0; slot < head_count; ++slot) {
        const uint32_t size = buckets[slot].cursor;
        buckets[slot].begin = buckets[slot].cursor = (uint32_t)offset;
        offset += size;
    }
    for (int64_t i = 0; i < count; ++i) {
        const dnaforge_chain_entry_t entry = dnaforge_chain_entry(&work->a[begin + i], (int32_t)i);
        const int64_t slot = reuse_bucket_positions ? state[i].fast
            : dnaforge_chain_entry_bucket(&entry, query_origin, max_dist_x, diagonal_bins, diagonal_bits);
        const uint32_t position = buckets[slot].cursor;
        entries[position] = entry;
        buckets[slot].cursor = position + 1;
    }
    for (int64_t slot = 0; slot < head_count; ++slot)
        buckets[slot].cursor = buckets[slot].begin;

    int64_t st = 0, max_ii = -1, previous_slot = 0;
    int has_fast = 0;
    for (int64_t i = 0; i < count; ++i) {
        const dnaforge_chain_entry_t current = dnaforge_chain_entry(&work->a[begin + i], (int32_t)i);
        int64_t j, end_j, max_j = -1;
        int32_t max_f = current.query_span >> 24, n_skip = 0;
        state[i].fast = 0;
        if (i > 0) ++buckets[previous_slot].cursor;
        while (st < i && (uint64_t)current.target > (uint64_t)(uint32_t)work->a[begin + st].x + max_dist_x) ++st;
        if (i - st > work->max_iter) st = i - work->max_iter;
        const int32_t query = dnaforge_chain_anchor_query(&current);
        const int64_t current_slot = dnaforge_chain_entry_bucket(&current, query_origin, max_dist_x, diagonal_bins, diagonal_bits);
        const int64_t current_bin = current_slot >> diagonal_bin_shift;
        previous_slot = current_slot;
        const uint32_t current_position = fast_enabled
            ? buckets[current_slot].cursor : 0;
        const uint32_t current_begin = fast_enabled
            ? buckets[current_slot].begin : 0;
        const int64_t current_diagonal = (int64_t)current.target - query;
        const int32_t low = query > max_dist_x ? query - max_dist_x : 0;
        dnaforge_chain_cursor_t cursors[4] = {
            { .position = -1, .index = -1 }, { .position = -1, .index = -1 },
            { .position = -1, .index = -1 }, { .position = -1, .index = -1 }
        };
        if (query > query_origin) {
            const int64_t low_bin = current_bin > 0 ? current_bin - 1 : 0;
            const int64_t high_bin = current_bin
                - ((int64_t)query - query_origin == current_bin * max_dist_x);
            const int64_t diagonal = current_diagonal;
            const int low_diagonal = ((uint64_t)(diagonal - bw) >> diagonal_bits) & (diagonal_bins - 1);
            const int high_diagonal = ((uint64_t)(diagonal + bw) >> diagonal_bits) & (diagonal_bins - 1);
            cursors[0] = dnaforge_chain_bucket_cursor(&buckets[low_bin * diagonal_bins + low_diagonal], entries);
            if (high_diagonal != low_diagonal) cursors[2] = dnaforge_chain_bucket_cursor(&buckets[low_bin * diagonal_bins + high_diagonal], entries);
            if (high_bin != low_bin) {
                cursors[1] = dnaforge_chain_bucket_cursor(&buckets[high_bin * diagonal_bins + low_diagonal], entries);
                if (high_diagonal != low_diagonal) cursors[3] = dnaforge_chain_bucket_cursor(&buckets[high_bin * diagonal_bins + high_diagonal], entries);
            }
        }
        int take_fast = 0;
        if (fast_enabled && current_position > current_begin
            && (state[entries[current_position - 1].index].fast & 0x7fffffffu) >= stop) {
            const dnaforge_chain_entry_t *previous = &entries[current_position - 1];
            const int64_t stopping = entries[current_position - stop].index;
            const int64_t delta = (int64_t)query - dnaforge_chain_anchor_query(previous);
            const int64_t score = (int64_t)state[previous->index].score + delta;
            const int64_t distance = (int64_t)current.target - entries[current_position - stop].target;
            int own_cursor = 0, isolated = 1;
            for (int cursor = 0; cursor < 4; ++cursor) {
                if (cursors[cursor].position == (int64_t)current_position - 1 && cursors[cursor].begin == current_begin)
                    own_cursor = 1;
                else if (cursors[cursor].index >= stopping) isolated = 0;
            }
            take_fast = own_cursor && isolated && stopping >= st
                && delta > 0 && delta == (int64_t)current.target - previous->target
                && delta <= (previous->query_span >> 24) && score > max_f && score <= INT32_MAX
                && distance >= 0 && distance <= max_dist_x && distance <= work->max_dist_y;
            if (take_fast) {
                max_f = (int32_t)score;
                max_j = previous->index;
                j = stopping;
                state[i].fast = 0x80000000u;
                has_fast = 1;
            }
        }
        if (!take_fast) for (;;) {
            const int first = cursors[0].index >= cursors[1].index ? 0 : 1;
            const int second = cursors[2].index >= cursors[3].index ? 2 : 3;
            const int selected = cursors[first].index >= cursors[second].index ? first : second;
            const int competing = selected < 2 ? second : first;
            const int32_t boundary = cursors[competing].index >= cursors[selected ^ 1].index
                ? cursors[competing].index : cursors[selected ^ 1].index;
            do {
                j = cursors[selected].index;
                if (j < st) { j = st - 1; goto dnaforge_packed_candidates_done; }
                const dnaforge_chain_entry_t *previous = &entries[cursors[selected].position--];
                cursors[selected].index = cursors[selected].position >= cursors[selected].begin
                    ? entries[cursors[selected].position].index : -1;
                const int32_t previous_query = dnaforge_chain_anchor_query(previous);
                if (previous_query < low || previous_query >= query) continue;
                const int32_t query_distance = query - previous_query;
                const int32_t target_distance = (int32_t)(current.target - previous->target);
                if (penalties && (target_distance == 0 || query_distance > max_dist_y)) continue;
                const int64_t diagonal_difference = current_diagonal - ((int64_t)previous->target - previous_query);
                if (diagonal_difference < -(int64_t)bw || diagonal_difference > bw) continue;
                int32_t score = penalties
                    ? dnaforge_chain_validated_score(previous->query_span >> 24, query_distance, target_distance,
                        (int32_t)(diagonal_difference < 0 ? -diagonal_difference : diagonal_difference), penalties)
                    : dnaforge_chain_anchor_score(work, &current, previous);
                if (score == INT32_MIN) continue;
                score += state[j].score;
                if (score > max_f) {
                    max_f = score; max_j = j;
                    if (n_skip > 0) --n_skip;
                } else if (tags[j] == (int32_t)(begin + i)) {
                    if (++n_skip > work->max_skip) goto dnaforge_packed_candidates_done;
                }
                if (state[j].predecessor >= 0) tags[state[j].predecessor] = (int32_t)(begin + i);
            } while (cursors[selected].index > boundary);
        }
        dnaforge_packed_candidates_done:
        end_j = j;
        if (max_ii < 0 || (uint64_t)current.target - (uint32_t)work->a[begin + max_ii].x > (int64_t)max_dist_x) {
            int32_t maximum = INT32_MIN;
            max_ii = -1;
            for (j = i - 1; j >= st; --j)
                if (maximum < state[j].score) { maximum = state[j].score; max_ii = j; }
        }
        if (max_ii >= 0 && max_ii < end_j) {
            const dnaforge_chain_entry_t previous = dnaforge_chain_entry(&work->a[begin + max_ii], (int32_t)max_ii);
            const int32_t score = dnaforge_chain_anchor_score(work, &current, &previous);
            if (score != INT32_MIN && max_f < score + state[max_ii].score) {
                max_f = score + state[max_ii].score; max_j = max_ii;
            }
        }
        state[i].score = max_f;
        state[i].predecessor = max_j;
        if (max_ii < 0 || ((uint64_t)current.target - (uint32_t)work->a[begin + max_ii].x <= (int64_t)max_dist_x && state[max_ii].score < state[i].score)) max_ii = i;
        if (fast_enabled) {
            uint32_t run_length = 1;
            if (current_position > current_begin) {
                const dnaforge_chain_entry_t *previous = &entries[current_position - 1];
                const int64_t delta = (int64_t)query - dnaforge_chain_anchor_query(previous);
                if (max_j == previous->index && delta > 0
                    && delta == (int64_t)current.target - previous->target
                    && (int64_t)max_f == (int64_t)state[previous->index].score + delta)
                    run_length += state[previous->index].fast & 0x7fffffffu;
            }
            state[i].fast |= run_length;
        }
    }
    if (has_fast) {
        for (int64_t slot = 0; slot < head_count; ++slot) {
            const int64_t first = buckets[slot].begin;
            const int64_t last = slot + 1 < head_count
                ? buckets[slot + 1].begin : count;
            int64_t latest = last - 1;
            for (int64_t at = last - 1; at >= first; --at) {
                const int64_t upper = at + stop < last ? at + stop : last - 1;
                while (latest >= first && (latest > upper || !(state[entries[latest].index].fast & 0x80000000u))) --latest;
                if (latest >= at + 2) {
                    const int32_t writer = (int32_t)(begin + entries[latest].index);
                    if (tags[entries[at].index] < writer) tags[entries[at].index] = writer;
                }
            }
        }
    }
    for (int64_t i = 0; i < count; ++i) {
        work->f[begin + i] = state[i].score;
        work->p[begin + i] = state[i].predecessor < 0 ? -1 : begin + state[i].predecessor;

    }
    if (work->v) dnaforge_chain_materialize_peaks(begin, end, work->f, work->p, work->v);
    free(buckets);
    free(state);
    free(entries);
    return 1;
}


static void dnaforge_chain_score_range_indexed(dnaforge_chain_work_t *work, int64_t begin, int64_t end, int32_t maximum_query_coordinate)
{
    if (dnaforge_chain_score_range_packed(work, begin, end, maximum_query_coordinate)) return;
    const mm128_t *a = work->a;
    int32_t *f = work->f, *t = work->t, *v = work->v, mmax_f = 0;
    int64_t *p = work->p, i, j, max_ii, st = begin;
    const int max_dist_x = work->max_dist_x, max_dist_y = work->max_dist_y;
    const int bw = work->bw, max_skip = work->max_skip, max_iter = work->max_iter;
    const int is_cdna = work->is_cdna, n_seg = work->n_seg;
    const float chn_pen_gap = work->chn_pen_gap, chn_pen_skip = work->chn_pen_skip;
    const int32_t *penalties = work->penalties;

    const int32_t query_origin = dnaforge_chain_query_origin(a, begin, end);
    const int64_t bins = ((int64_t)maximum_query_coordinate - query_origin) / max_dist_x + 1;
    if (end <= begin || (uint64_t)(end - begin) > SIZE_MAX / sizeof(int64_t) || (uint64_t)bins > (uint64_t)(end - begin) * 4) {
        dnaforge_chain_score_range_scalar(work, begin, end);
        return;
    }
    int diagonal_bits = 0, diagonal_bins = 1;
    if (penalties) {
        const uint64_t segment = a[begin].y & MM_SEED_SEG_MASK;
        int uniform_segment = 1;
        for (int64_t anchor = begin; anchor < end; ++anchor)
            if ((a[anchor].y & MM_SEED_SEG_MASK) != segment) { uniform_segment = 0; break; }
        if (uniform_segment) {
            diagonal_bins = dnaforge_chain_diagonal_bins(max_dist_x, bw, bins, end - begin, &diagonal_bits);
            if (!diagonal_bins) {
                dnaforge_chain_score_range_scalar(work, begin, end);
                return;
            }
        }
    }
    const int64_t head_count = bins * diagonal_bins;
    int64_t *heads = (int64_t *)malloc((size_t)head_count * sizeof(int64_t));
    int64_t *next = (int64_t *)malloc((size_t)(end - begin) * sizeof(int64_t));
    if (!heads || !next) {
        free(heads); free(next);
        dnaforge_chain_score_range_scalar(work, begin, end);
        return;
    }
    for (i = 0; i < head_count; ++i) heads[i] = -1;
	for (i = begin, max_ii = -1; i < end; ++i) {
		int64_t max_j = -1, end_j;
		int32_t max_f = a[i].y>>32&0xff, n_skip = 0;
        if (i > begin) {
            int64_t previous = i - 1;
            int64_t bin = ((int32_t)a[previous].y - query_origin) / max_dist_x;
            const int64_t diagonal = (int64_t)(uint32_t)a[previous].x - (int32_t)a[previous].y;
            const int64_t slot = bin * diagonal_bins + (((uint64_t)diagonal >> diagonal_bits) & (diagonal_bins - 1));
            next[previous - begin] = heads[slot];
            heads[slot] = previous;
        }
		while (st < i && (a[i].x>>32 != a[st].x>>32 || a[i].x > a[st].x + max_dist_x)) ++st;
		if (i - st > max_iter) st = i - max_iter;
        const int32_t query_coordinate = (int32_t)a[i].y;
        const int64_t current_diagonal = (int64_t)(uint32_t)a[i].x - query_coordinate;
        const int32_t low = query_coordinate > max_dist_x ? query_coordinate - max_dist_x : 0;
        int64_t left = -1, right = -1, left_extra = -1, right_extra = -1;
        if (query_coordinate > query_origin) {
            const int64_t low_bin = low > query_origin ? (low - query_origin) / max_dist_x : 0;
            const int64_t high_bin = (query_coordinate - query_origin - 1) / max_dist_x;
            const int64_t diagonal = (int64_t)(uint32_t)a[i].x - query_coordinate;
            const int low_diagonal = ((uint64_t)(diagonal - bw) >> diagonal_bits) & (diagonal_bins - 1);
            const int high_diagonal = ((uint64_t)(diagonal + bw) >> diagonal_bits) & (diagonal_bins - 1);
            left = heads[low_bin * diagonal_bins + low_diagonal];
            if (high_diagonal != low_diagonal) left_extra = heads[low_bin * diagonal_bins + high_diagonal];
            if (high_bin != low_bin) {
                right = heads[high_bin * diagonal_bins + low_diagonal];
                if (high_diagonal != low_diagonal) right_extra = heads[high_bin * diagonal_bins + high_diagonal];
            }
        }
        for (;;) {
            const int64_t first = left >= right ? left : right;
            const int64_t second = left_extra >= right_extra ? left_extra : right_extra;
            j = first >= second ? first : second;
            if (j < st) { j = st - 1; break; }
            if (j == left) left = next[j - begin];
            else if (j == right) right = next[j - begin];
            else if (j == left_extra) left_extra = next[j - begin];
            else right_extra = next[j - begin];
            const int32_t previous_coordinate = (int32_t)a[j].y;
            if (previous_coordinate < low || previous_coordinate >= query_coordinate) continue;
            if (diagonal_bins > 1 && !dnaforge_chain_diagonal_in_band(current_diagonal, (int64_t)(uint32_t)a[j].x - previous_coordinate, bw)) continue;
			int32_t sc;
			sc = dnaforge_comput_cached_sc(&a[i], &a[j], max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg, penalties);
			if (sc == INT32_MIN) continue;
			sc += f[j];
			if (sc > max_f) {
				max_f = sc, max_j = j;
				if (n_skip > 0) --n_skip;
			} else if (t[j] == (int32_t)i) {
				if (++n_skip > max_skip)
					break;
			}
			if (p[j] >= 0) t[p[j]] = i;
        }
		end_j = j;
		if (max_ii < 0 || a[i].x - a[max_ii].x > (int64_t)max_dist_x) {
			int32_t max = INT32_MIN;
			max_ii = -1;
			for (j = i - 1; j >= st; --j)
				if (max < f[j]) max = f[j], max_ii = j;
		}
		if (max_ii >= 0 && max_ii < end_j) {
			int32_t tmp;
			tmp = dnaforge_comput_cached_sc(&a[i], &a[max_ii], max_dist_x, max_dist_y, bw, chn_pen_gap, chn_pen_skip, is_cdna, n_seg, penalties);
			if (tmp != INT32_MIN && max_f < tmp + f[max_ii])
				max_f = tmp + f[max_ii], max_j = max_ii;
		}
		f[i] = max_f, p[i] = max_j;
        if (v) v[i] = dnaforge_chain_peak_at(f, p, v, i);
		if (max_ii < 0 || (a[i].x - a[max_ii].x <= (int64_t)max_dist_x && f[max_ii] < f[i]))
			max_ii = i;
		if (mmax_f < max_f) mmax_f = max_f;
		//fprintf(stderr, "X1\t%ld\t%ld:%d\t%ld\t%ld:%d\t%ld\t%ld\n", (long)i, (long)(a[i].x>>32), (int32_t)a[i].x, (long)max_j, max_j<0?-1L:(long)(a[max_j].x>>32), max_j<0?-1:(int32_t)a[max_j].x, (long)max_f, (long)v[i]);
	}

    free(heads);
    free(next);

}


static void dnaforge_chain_score_range(dnaforge_chain_work_t *work, int64_t begin, int64_t end)
{
    if (end - begin < 64 || work->max_dist_x < 1) {
        dnaforge_chain_score_range_scalar(work, begin, end);
        return;
    }
    int32_t maximum = 0;
    for (int64_t i = begin; i < end; ++i) {
        const int32_t coordinate = (int32_t)work->a[i].y;
        if (coordinate < 0) {
            dnaforge_chain_score_range_scalar(work, begin, end);
            return;
        }
        if (maximum < coordinate) maximum = coordinate;
    }
    dnaforge_chain_score_range_indexed(work, begin, end, maximum);
}

static int dnaforge_chain_cache_load(dnaforge_chain_work_t *work, int64_t begin, int64_t end, uint64_t *hash);
static void dnaforge_chain_cache_store(dnaforge_chain_work_t *work, int64_t begin, int64_t end, uint64_t hash);

static void dnaforge_chain_score_single(dnaforge_chain_work_t *shared, int64_t begin, int64_t end)
{
    dnaforge_chain_work_t local = *shared;
    local.arena = 0;
    uint64_t hash;
    const int cached = dnaforge_chain_cache_load(&local, begin, end, &hash);
    if (cached == 1) return;
    shared->score_range(&local, begin, end);
    if (cached == 0) dnaforge_chain_cache_store(&local, begin, end, hash);
    km_destroy(local.arena);
}

static void *dnaforge_chain_worker(void *data)
{
    dnaforge_chain_schedule_t *schedule = (dnaforge_chain_schedule_t *)data;
    dnaforge_chain_work_t *work = schedule->work;
    dnaforge_chain_work_t local = *work;
    local.arena = 0;
    for (;;) {
        int64_t group = __sync_fetch_and_add(&schedule->next_group, 1);
        if (group >= work->groups) break;
        if (work->reuse_from && work->reuse_from[group] >= 0) continue;
        uint64_t hash;
        const int cached = dnaforge_chain_cache_load(&local, work->bounds[group], work->bounds[group + 1], &hash);
        if (cached == 1) continue;
        work->score_range(&local, work->bounds[group], work->bounds[group + 1]);
        if (cached == 0) dnaforge_chain_cache_store(&local, work->bounds[group], work->bounds[group + 1], hash);
    }
    km_destroy(local.arena);
    return 0;
}

static uint64_t dnaforge_chain_group_hash(const mm128_t *a, int64_t begin, int64_t end)
{
    uint64_t hash = (uint64_t)(end - begin) ^ 0xcbf29ce484222325ULL;
    const uint32_t origin = (uint32_t)a[begin].x, query_origin = (uint32_t)a[begin].y;
    for (int64_t i = begin; i < end; ++i) {
        hash = (hash ^ ((uint32_t)a[i].x - origin)) * 0x100000001b3ULL;
        const uint64_t query = (a[i].y & 0xffffffff00000000ULL) | ((uint32_t)a[i].y - query_origin);
        hash = (hash ^ query) * 0x100000001b3ULL;
    }
    return hash;
}

static int dnaforge_chain_groups_equal(const mm128_t *a, int64_t left, int64_t right, int64_t count)
{
    const uint32_t left_origin = (uint32_t)a[left].x, right_origin = (uint32_t)a[right].x;
    const uint32_t left_query = (uint32_t)a[left].y, right_query = (uint32_t)a[right].y;
    for (int64_t i = 0; i < count; ++i)
        if ((uint32_t)a[left + i].x - left_origin != (uint32_t)a[right + i].x - right_origin ||
            a[left + i].y >> 32 != a[right + i].y >> 32 ||
            (uint32_t)a[left + i].y - left_query != (uint32_t)a[right + i].y - right_query) return 0;
    return 1;
}

static int dnaforge_chain_group_exact_translation(const dnaforge_chain_work_t *work, int64_t begin, int64_t end)
{
    if (FLT_RADIX != 2 || FLT_MANT_DIG != 24 || DBL_MANT_DIG != 53 || sizeof(float) != sizeof(uint32_t)) return 0;
    const uint32_t maximum_target = (uint32_t)work->a[end - 1].x;
    uint32_t maximum_query = 0;
    if ((uint64_t)maximum_target + (uint64_t)work->max_dist_x > INT32_MAX) return 0;
    for (int64_t i = begin; i < end; ++i) {
        if (work->t[i] != 0 || (int32_t)work->a[i].y < 0) return 0;
        if (maximum_query < (uint32_t)work->a[i].y) maximum_query = (uint32_t)work->a[i].y;
    }
    const uint64_t maximum_sum = (uint64_t)maximum_target + maximum_query;
    if (maximum_sum > INT32_MAX || maximum_query > INT32_MAX - 255) return 0;
    uint32_t gap_bits;
    memcpy(&gap_bits, &work->chn_pen_gap, sizeof(gap_bits));
    const uint32_t encoded_exponent = (gap_bits >> 23) & 0xff;
    uint32_t mantissa = gap_bits & 0x7fffff;
    if (encoded_exponent == 0xff) return 0;
    if (encoded_exponent) mantissa |= 1u << 23;
    if (!mantissa || !maximum_sum) return 1;
    if (gap_bits >> 31) return 0;
    int exponent = encoded_exponent ? (int)encoded_exponent - 150 : -149;
    const int trailing = __builtin_ctz(mantissa);
    mantissa >>= trailing;
    exponent += trailing - 1;
    const int product_bits = 32 - __builtin_clz(mantissa) + 64 - __builtin_clzll(maximum_sum);
    const int score_bits = 64 - __builtin_clzll((uint64_t)maximum_query + 255);
    if (exponent < 0) return product_bits <= 52 && score_bits - exponent <= 52;
    return product_bits + exponent <= 52 && score_bits <= 52;
}

static void dnaforge_rmq_score_range(dnaforge_chain_work_t *work, int64_t begin, int64_t end);

typedef struct {
    uint64_t query;
    uint32_t target;
    int32_t score;
    uint32_t predecessor, tag;
} dnaforge_cached_anchor_t;

typedef struct dnaforge_chain_cache_entry_s {
    struct dnaforge_chain_cache_entry_s *hash_next, *older, *newer;
    uint64_t hash;
    uint32_t count, parameters[12];
    dnaforge_cached_anchor_t anchors[];
} dnaforge_chain_cache_entry_t;

struct dnaforge_chain_cache_s {
    pthread_mutex_t mutex;
    size_t limit, bytes, peak;
    uint64_t hits, misses, entries;
    dnaforge_chain_cache_entry_t *newest, *oldest, *table[16384];
};

_Static_assert(sizeof(dnaforge_cached_anchor_t) == 24, "Cached scientific state must remain bounded.");

dnaforge_chain_cache_t *dnaforge_chain_cache_init(size_t limit)
{
    if (limit < sizeof(dnaforge_chain_cache_t)) return 0;
    dnaforge_chain_cache_t *cache = (dnaforge_chain_cache_t *)calloc(1, sizeof(*cache));
    if (!cache) return 0;
    if (pthread_mutex_init(&cache->mutex, 0) != 0) { free(cache); return 0; }
    cache->limit = limit;
    cache->bytes = cache->peak = sizeof(*cache);
    return cache;
}

static void dnaforge_chain_cache_newest(dnaforge_chain_cache_t *cache, dnaforge_chain_cache_entry_t *entry)
{
    entry->newer = 0;
    entry->older = cache->newest;
    if (cache->newest) cache->newest->newer = entry;
    else cache->oldest = entry;
    cache->newest = entry;
}

static void dnaforge_chain_cache_touch(dnaforge_chain_cache_t *cache, dnaforge_chain_cache_entry_t *entry)
{
    if (cache->newest == entry) return;
    if (entry->newer) entry->newer->older = entry->older;
    if (entry->older) entry->older->newer = entry->newer;
    else cache->oldest = entry->newer;
    dnaforge_chain_cache_newest(cache, entry);
}

static void dnaforge_chain_cache_evict(dnaforge_chain_cache_t *cache)
{
    dnaforge_chain_cache_entry_t *entry = cache->oldest;
    assert(entry != 0);
    dnaforge_chain_cache_entry_t **slot = &cache->table[entry->hash & 16383];
    while (*slot && *slot != entry) slot = &(*slot)->hash_next;
    assert(*slot == entry);
    *slot = entry->hash_next;
    cache->oldest = entry->newer;
    if (cache->oldest) cache->oldest->older = 0;
    else cache->newest = 0;
    cache->bytes -= sizeof(*entry) + (size_t)entry->count * sizeof(entry->anchors[0]);
    --cache->entries;
    free(entry);
}

void dnaforge_chain_cache_destroy(dnaforge_chain_cache_t *cache)
{
    if (!cache) return;
    while (cache->oldest) dnaforge_chain_cache_evict(cache);
    pthread_mutex_destroy(&cache->mutex);
    free(cache);
}

static void dnaforge_chain_cache_parameters(const dnaforge_chain_work_t *work, uint32_t parameters[12])
{
    parameters[0] = work->max_dist_x;
    parameters[1] = work->max_dist_y;
    parameters[2] = work->bw;
    parameters[3] = work->max_skip;
    parameters[4] = work->max_iter;
    parameters[5] = work->is_cdna;
    parameters[6] = work->n_seg;
    parameters[7] = work->max_dist_inner;
    parameters[8] = work->cap_rmq_size;
    memcpy(&parameters[9], &work->chn_pen_gap, sizeof(uint32_t));
    memcpy(&parameters[10], &work->chn_pen_skip, sizeof(uint32_t));
    parameters[11] = work->score_range == dnaforge_chain_score_range;
}

static int dnaforge_chain_cache_matches(const dnaforge_chain_cache_entry_t *entry, const dnaforge_chain_work_t *work, int64_t begin, int64_t end, uint64_t hash, const uint32_t parameters[12])
{
    if (entry->hash != hash || entry->count != end - begin || memcmp(entry->parameters, parameters, sizeof(entry->parameters))) return 0;
    const uint32_t target = (uint32_t)work->a[begin].x, query = (uint32_t)work->a[begin].y;
    for (uint32_t i = 0; i < entry->count; ++i) {
        const mm128_t anchor = work->a[begin + i];
        if (entry->anchors[i].target != (uint32_t)anchor.x - target ||
            entry->anchors[i].query != ((anchor.y & 0xffffffff00000000ULL) | ((uint32_t)anchor.y - query))) return 0;
    }
    return 1;
}

static int dnaforge_chain_cache_load(dnaforge_chain_work_t *work, int64_t begin, int64_t end, uint64_t *hash)
{
    if (!work->cache || !work->penalties || begin <= 0 || end > INT32_MAX || end - begin < 64 || end - begin > UINT16_MAX || work->max_dist_x < 0 ||
        (work->score_range != dnaforge_chain_score_range && work->score_range != dnaforge_rmq_score_range) ||
        !dnaforge_chain_group_exact_translation(work, begin, end)) return -1;
    uint32_t parameters[12];
    dnaforge_chain_cache_parameters(work, parameters);
    uint64_t value = dnaforge_chain_group_hash(work->a, begin, end);
    for (int i = 0; i < 12; ++i) value = (value ^ parameters[i]) * 0x100000001b3ULL;
    *hash = value;
    dnaforge_chain_cache_t *cache = work->cache;
    pthread_mutex_lock(&cache->mutex);
    for (dnaforge_chain_cache_entry_t *entry = cache->table[value & 16383]; entry; entry = entry->hash_next) {
        if (!dnaforge_chain_cache_matches(entry, work, begin, end, value, parameters)) continue;
        for (uint32_t i = 0; i < entry->count; ++i) {
            const dnaforge_cached_anchor_t *anchor = &entry->anchors[i];
            work->f[begin + i] = anchor->score;
            work->p[begin + i] = anchor->predecessor ? begin + anchor->predecessor - 1 : -1;
            work->t[begin + i] = anchor->tag ? (int32_t)(begin + anchor->tag - 1) : 0;
        }
        if (work->v) dnaforge_chain_materialize_peaks(begin, end, work->f, work->p, work->v);
        dnaforge_chain_cache_touch(cache, entry);
        ++cache->hits;
        pthread_mutex_unlock(&cache->mutex);
        return 1;
    }
    ++cache->misses;
    pthread_mutex_unlock(&cache->mutex);
    return 0;
}

static void dnaforge_chain_cache_store(dnaforge_chain_work_t *work, int64_t begin, int64_t end, uint64_t hash)
{
    const size_t bytes = sizeof(dnaforge_chain_cache_entry_t) + (size_t)(end - begin) * sizeof(dnaforge_cached_anchor_t);
    dnaforge_chain_cache_t *cache = work->cache;
    if (bytes > cache->limit - sizeof(*cache)) return;
    for (int64_t i = begin; i < end; ++i)
        if (work->p[i] < -1 || (work->p[i] >= 0 && (work->p[i] < begin || work->p[i] >= i)) ||
            (work->t[i] != 0 && (work->t[i] < begin || work->t[i] >= end))) return;
    uint32_t parameters[12];
    dnaforge_chain_cache_parameters(work, parameters);
    pthread_mutex_lock(&cache->mutex);
    for (dnaforge_chain_cache_entry_t *entry = cache->table[hash & 16383]; entry; entry = entry->hash_next)
        if (dnaforge_chain_cache_matches(entry, work, begin, end, hash, parameters)) {
            dnaforge_chain_cache_touch(cache, entry);
            pthread_mutex_unlock(&cache->mutex);
            return;
        }
    while (cache->bytes > cache->limit - bytes) dnaforge_chain_cache_evict(cache);
    dnaforge_chain_cache_entry_t *entry = (dnaforge_chain_cache_entry_t *)malloc(bytes);
    if (!entry) { pthread_mutex_unlock(&cache->mutex); return; }
    entry->hash = hash;
    entry->count = (uint32_t)(end - begin);
    memcpy(entry->parameters, parameters, sizeof(parameters));
    const uint32_t target = (uint32_t)work->a[begin].x, query = (uint32_t)work->a[begin].y;
    for (uint32_t i = 0; i < entry->count; ++i) {
        const mm128_t anchor = work->a[begin + i];
        entry->anchors[i] = (dnaforge_cached_anchor_t){
            .target = (uint32_t)anchor.x - target,
            .query = (anchor.y & 0xffffffff00000000ULL) | ((uint32_t)anchor.y - query),
            .score = work->f[begin + i],
            .predecessor = work->p[begin + i] < 0 ? 0 : (uint32_t)(work->p[begin + i] - begin + 1),
            .tag = work->t[begin + i] == 0 ? 0 : (uint32_t)(work->t[begin + i] - begin + 1)
        };
    }
    entry->hash_next = cache->table[hash & 16383];
    cache->table[hash & 16383] = entry;
    dnaforge_chain_cache_newest(cache, entry);
    ++cache->entries;
    cache->bytes += bytes;
    if (cache->peak < cache->bytes) cache->peak = cache->bytes;
    pthread_mutex_unlock(&cache->mutex);
}

static int64_t *dnaforge_chain_reuse_plan(const dnaforge_chain_work_t *work)
{
    if (!work->penalties || work->count > INT32_MAX || work->groups < 3 || work->groups > work->count / 64 || work->max_dist_x < 0) return 0;
    size_t capacity = 1;
    while (capacity < (uint64_t)work->groups * 2) capacity *= 2;
    int64_t *leaders = (int64_t *)malloc((size_t)work->groups * sizeof(int64_t));
    int64_t *table = (int64_t *)malloc(capacity * sizeof(int64_t));
    uint64_t *hashes = (uint64_t *)malloc(capacity * sizeof(uint64_t));
    if (!leaders || !table || !hashes) { free(leaders); free(table); free(hashes); return 0; }
    for (int64_t group = 0; group < work->groups; ++group) leaders[group] = -1;
    for (size_t slot = 0; slot < capacity; ++slot) table[slot] = -1;
    int reused = 0;
    for (int64_t group = 1; group < work->groups; ++group) {
        const int64_t begin = work->bounds[group], end = work->bounds[group + 1], count = end - begin;
        if (count < 64 || !dnaforge_chain_group_exact_translation(work, begin, end)) continue;
        const uint64_t hash = dnaforge_chain_group_hash(work->a, begin, end);
        size_t slot = hash & (capacity - 1);
        while (table[slot] >= 0) {
            const int64_t candidate = table[slot], candidate_begin = work->bounds[candidate];
            if (hashes[slot] == hash && work->bounds[candidate + 1] - candidate_begin == count &&
                dnaforge_chain_groups_equal(work->a, begin, candidate_begin, count)) {
                leaders[group] = candidate;
                ++reused;
                break;
            }
            slot = (slot + 1) & (capacity - 1);
        }
        if (leaders[group] < 0) { table[slot] = group; hashes[slot] = hash; }
    }
    free(table); free(hashes);
    if (!reused) { free(leaders); return 0; }
    return leaders;
}

static int dnaforge_chain_copy_group(dnaforge_chain_work_t *work, int64_t source_group, int64_t destination_group)
{
    const int64_t source = work->bounds[source_group], end = work->bounds[source_group + 1];
    const int64_t destination = work->bounds[destination_group], count = end - source, shift = destination - source;
    for (int64_t i = source; i < end; ++i)
        if ((work->p[i] >= 0 && (work->p[i] < source || work->p[i] >= end)) ||
            (work->t[i] != 0 && (work->t[i] < source || work->t[i] >= end))) return 0;
    memcpy(work->f + destination, work->f + source, (size_t)count * sizeof(int32_t));
    if (work->v) memcpy(work->v + destination, work->v + source, (size_t)count * sizeof(int32_t));
    for (int64_t i = 0; i < count; ++i) {
        work->p[destination + i] = work->p[source + i] < 0 ? work->p[source + i] : work->p[source + i] + shift;
        work->t[destination + i] = work->t[source + i] == 0 ? 0 : (int32_t)(work->t[source + i] + shift);
    }
    return 1;
}


static void dnaforge_chain_score_all(dnaforge_chain_work_t *work, int64_t n, void (*score_range)(dnaforge_chain_work_t *, int64_t, int64_t))
{
    work->score_range = score_range;
    work->coherent_runs = score_range == dnaforge_chain_score_range && work->penalties
        && work->n_seg == 1 && !work->is_cdna && work->chn_pen_skip == 0.0f
        && work->chn_pen_gap >= 0.0f && work->chn_pen_gap <= FLT_MAX
        && work->bw >= 0 && work->bw <= 32768 && work->penalties[0] == 0;
    work->count = n;
    work->reuse_from = 0;
    long cpus = sysconf(_SC_NPROCESSORS_ONLN);
    int threads = cpus > MM_DNAFORGE_MAP_THREAD_LIMIT ? MM_DNAFORGE_MAP_THREAD_LIMIT : cpus > 0 ? (int)cpus : 1;
    int64_t groups = 1, i, group;
    pthread_t workers[MM_DNAFORGE_MAP_THREAD_LIMIT];
    int created = 0;
    dnaforge_chain_schedule_t schedule = { .work = work, .next_group = 0 };
    if (n < 512) {
        dnaforge_chain_score_single(work, 0, n);
        return;
    }
    if (n < 50000) threads = 1;
    for (i = 1; i < n; ++i)
        if (work->a[i].x >> 32 != work->a[i - 1].x >> 32) {
            if (score_range == dnaforge_chain_score_range && work->a[i].x - work->a[i - 1].x <= (uint64_t)work->max_dist_x) {
                dnaforge_chain_score_single(work, 0, n);
                return;
            }
            ++groups;
        }
    if (groups < 2) {
        dnaforge_chain_score_single(work, 0, n);
        return;
    }
    work->bounds = (int64_t *)malloc((groups + 1) * sizeof(int64_t));
    if (!work->bounds) {
        dnaforge_chain_score_single(work, 0, n);
        return;
    }
    work->bounds[0] = 0;
    for (i = 1, group = 1; i < n; ++i)
        if (work->a[i].x >> 32 != work->a[i - 1].x >> 32) work->bounds[group++] = i;
    work->bounds[groups] = n;
    work->groups = groups;
    if (score_range == dnaforge_chain_score_range || score_range == dnaforge_rmq_score_range)
        work->reuse_from = dnaforge_chain_reuse_plan(work);
    if (groups < threads) threads = (int)groups;
    for (i = 0; i < threads - 1; ++i) {
        if (pthread_create(&workers[created], 0, dnaforge_chain_worker, &schedule) != 0) break;
        ++created;
    }
    dnaforge_chain_worker(&schedule);
    for (i = 0; i < created; ++i)
        if (pthread_join(workers[i], 0) != 0) abort();
    if (work->reuse_from) {
        for (group = 1; group < groups; ++group)
            if (work->reuse_from[group] >= 0 && !dnaforge_chain_copy_group(work, work->reuse_from[group], group))
                dnaforge_chain_score_single(work, work->bounds[group], work->bounds[group + 1]);
        free(work->reuse_from);
        work->reuse_from = 0;
    }
    free(work->bounds);
    work->bounds = 0;
}

/* Input:
 *   a[].x: rev<<63 | tid<<32 | tpos
 *   a[].y: flags<<40 | q_span<<32 | q_pos
 * Output:
 *   n_u: #chains
 *   u[]: score<<32 | #anchors (sum of lower 32 bits of u[] is the returned length of a[])
 * input a[] is deallocated on return
 */
mm128_t *dnaforge_lchain_dp_cached(int max_dist_x, int max_dist_y, int bw, int max_skip, int max_iter, int min_cnt, int min_sc, float chn_pen_gap, float chn_pen_skip,
					  int is_cdna, int n_seg, int64_t n, mm128_t *a, int *n_u_, uint64_t **_u, void *km, dnaforge_chain_cache_t *cache)
{ // TODO: make sure this works when n has more than 32 bits
	int32_t *f, *t, *v, n_u, n_v, max_drop = bw;
	int64_t *p;
	uint64_t *u;

	if (_u) *_u = 0, *n_u_ = 0;
	if (n == 0 || a == 0) {
		kfree(km, a);
		return 0;
	}
	if (max_dist_x < bw) max_dist_x = bw;
	if (max_dist_y < bw && !is_cdna) max_dist_y = bw;
	if (is_cdna) max_drop = INT32_MAX;
	p = Kmalloc(km, int64_t, n);
	f = Kmalloc(km, int32_t, n);
	v = 0;
	t = Kcalloc(km, int32_t, n);

	// fill the score and backtrack arrays
    dnaforge_chain_work_t work = {
        .a = a, .f = f, .t = t, .v = v, .p = p, .cache = cache,
        .max_dist_x = max_dist_x, .max_dist_y = max_dist_y, .bw = bw,
        .max_skip = max_skip, .max_iter = max_iter, .is_cdna = is_cdna, .n_seg = n_seg,
        .chn_pen_gap = chn_pen_gap, .chn_pen_skip = chn_pen_skip,
        .bounds = 0, .groups = 0
    };
    work.penalties = dnaforge_prepare_chain_penalties(&work);
    dnaforge_chain_score_all(&work, n, dnaforge_chain_score_range);
    free(work.penalties);

	v = Kmalloc(km, int32_t, n);
	u = mg_chain_backtrack(km, n, f, p, v, t, min_cnt, min_sc, max_drop, &n_u, &n_v);
	*n_u_ = n_u, *_u = u; // NB: note that u[] may not be sorted by score here
	kfree(km, p); kfree(km, f); kfree(km, t);
	if (n_u == 0) {
		kfree(km, a); kfree(km, v);
		return 0;
	}
	return compact_a(km, n_u, u, n_v, v, a);
}

mm128_t *mg_lchain_dp(int max_dist_x, int max_dist_y, int bw, int max_skip, int max_iter, int min_cnt, int min_sc, float chn_pen_gap, float chn_pen_skip,
					  int is_cdna, int n_seg, int64_t n, mm128_t *a, int *n_u_, uint64_t **_u, void *km)
{
    return dnaforge_lchain_dp_cached(max_dist_x, max_dist_y, bw, max_skip, max_iter, min_cnt, min_sc, chn_pen_gap, chn_pen_skip, is_cdna, n_seg, n, a, n_u_, _u, km, 0);
}

typedef struct lc_elem_s {
	int32_t y;
	int64_t i;
	double pri;
	KRMQ_HEAD(struct lc_elem_s) head;
} lc_elem_t;

#define lc_elem_cmp(a, b) ((a)->y < (b)->y? -1 : (a)->y > (b)->y? 1 : ((a)->i > (b)->i) - ((a)->i < (b)->i))
#define lc_elem_lt2(a, b) ((a)->pri < (b)->pri)
KRMQ_INIT2(lc_elem, static inline __attribute__((always_inline)), lc_elem_t, head, lc_elem_cmp, lc_elem_lt2)

KALLOC_POOL_INIT(rmq, lc_elem_t)

typedef struct {
    int enabled, minimum, maximum, words, summaries, slots;
    int64_t begin, end, count;
    int64_t *head, *tail, *previous, *next;
    uint64_t *bits, *summary;
    int32_t *coordinates, *ranks;
} dnaforge_inner_index_t;

static dnaforge_inner_index_t dnaforge_inner_index_init(void *km, const mm128_t *a, int64_t begin, int64_t end, int inner_distance, int capacity)
{
    dnaforge_inner_index_t index = {0};
    if (inner_distance <= 0 || capacity <= 0 || end - begin < 64 || end - begin > 8000000) return index;
    index.minimum = INT32_MAX;
    for (int64_t i = begin; i < end; ++i) {
        int32_t y = (int32_t)a[i].y;
        if (y < 0) return index;
        if (index.minimum > y) index.minimum = y;
        if (index.maximum < y) index.maximum = y;
    }
    const int interval = index.maximum - index.minimum;
    index.begin = begin;
    index.end = end;
    index.slots = interval <= 65535 ? interval + 1 : 0;
    if (interval > 65535 || (int64_t)interval + 1 > (end - begin) * 4) {
        const int64_t count = end - begin;
        uint64_t *keys = Kmalloc(km, uint64_t, count);
        index.coordinates = Kmalloc(km, int32_t, count);
        index.ranks = Kmalloc(km, int32_t, count);
        if (!keys || !index.coordinates || !index.ranks) {
            kfree(km, keys); kfree(km, index.coordinates); kfree(km, index.ranks);
            return (dnaforge_inner_index_t){0};
        }
        for (int64_t i = 0; i < count; ++i)
            keys[i] = (uint64_t)(uint32_t)a[begin + i].y << 32 | (uint32_t)i;
        radix_sort_64(keys, keys + count);
        index.slots = 0;
        for (int64_t i = 0; i < count; ++i) {
            int32_t coordinate = keys[i] >> 32;
            if (!index.slots || index.coordinates[index.slots - 1] != coordinate)
                index.coordinates[index.slots++] = coordinate;
            index.ranks[(uint32_t)keys[i]] = index.slots - 1;
        }
        kfree(km, keys);
    }
    index.words = (index.slots + 63) / 64;
    index.summaries = (index.words + 63) / 64;
    index.head = Kmalloc(km, int64_t, index.slots);
    index.tail = Kmalloc(km, int64_t, index.slots);
    index.previous = Kmalloc(km, int64_t, end - begin);
    index.next = Kmalloc(km, int64_t, end - begin);
    index.bits = Kcalloc(km, uint64_t, index.words);
    index.summary = Kcalloc(km, uint64_t, index.summaries);
    if (!index.head || !index.tail || !index.previous || !index.next || !index.bits || !index.summary) {
        kfree(km, index.head); kfree(km, index.tail);
        kfree(km, index.previous); kfree(km, index.next);
        kfree(km, index.bits); kfree(km, index.summary);
        kfree(km, index.coordinates); kfree(km, index.ranks);
        return (dnaforge_inner_index_t){0};
    }
    for (int y = 0; y < index.slots; ++y) index.head[y] = index.tail[y] = -1;
    index.enabled = 1;
    return index;
}

static int dnaforge_inner_index_insert(dnaforge_inner_index_t *index, int32_t y, int64_t i)
{
    if (y < index->minimum || y > index->maximum || i < index->begin || i >= index->end) return 0;
    if (index->coordinates) {
        int32_t rank = index->ranks[i - index->begin];
        if (index->coordinates[rank] != y) return 0;
        y = rank;
    } else y -= index->minimum;
    int64_t tail = index->tail[y];
    if (tail >= i) return 0;
    index->previous[i - index->begin] = tail;
    index->next[i - index->begin] = -1;
    if (tail >= 0) index->next[tail - index->begin] = i;
    else {
        index->head[y] = i;
        unsigned word = (unsigned)y >> 6;
        index->bits[word] |= 1ULL << (y & 63);
        index->summary[word >> 6] |= 1ULL << (word & 63);
    }
    index->tail[y] = i;
    ++index->count;
    return 1;
}

static int dnaforge_inner_index_erase(dnaforge_inner_index_t *index, int32_t y, int64_t i)
{
    if (y < index->minimum || y > index->maximum || i < index->begin || i >= index->end || index->count <= 0) return 0;
    if (index->coordinates) {
        int32_t rank = index->ranks[i - index->begin];
        if (index->coordinates[rank] != y) return 0;
        y = rank;
    } else y -= index->minimum;
    if (index->head[y] != i) return 0;
    int64_t next = index->next[i - index->begin];
    index->head[y] = next;
    if (next >= 0) index->previous[next - index->begin] = -1;
    else {
        index->tail[y] = -1;
        unsigned word = (unsigned)y >> 6;
        index->bits[word] &= ~(1ULL << (y & 63));
        if (!index->bits[word]) index->summary[word >> 6] &= ~(1ULL << (word & 63));
    }
    --index->count;
    return 1;
}

static inline __attribute__((always_inline)) int64_t dnaforge_inner_index_predecessor_slot(const dnaforge_inner_index_t *index, int32_t y)
{
    if (y < 0 || !index->count) return -1;
    int word = y >> 6;
    unsigned bit = y & 63;
    uint64_t bits = index->bits[word] & (bit == 63 ? UINT64_MAX : (1ULL << (bit + 1)) - 1);
    if (!bits) {
        int summary = word >> 6;
        bit = word & 63;
        uint64_t words = index->summary[summary] & (bit == 0 ? 0 : (1ULL << bit) - 1);
        while (!words) {
            if (--summary < 0) return -1;
            words = index->summary[summary];
        }
        word = summary * 64 + 63 - __builtin_clzll(words);
        bits = index->bits[word];
    }
    y = word * 64 + 63 - __builtin_clzll(bits);
    return index->tail[y];
}

static inline __attribute__((always_inline)) int64_t dnaforge_inner_index_predecessor(const dnaforge_inner_index_t *index, int32_t y)
{
    if (y < index->minimum || !index->count) return -1;
    if (y > index->maximum) y = index->maximum;
    if (index->coordinates) {
        int32_t low = 0, high = index->slots;
        while (low < high) {
            int32_t middle = low + (high - low) / 2;
            if (index->coordinates[middle] <= y) low = middle + 1;
            else high = middle;
        }
        y = low - 1;
    } else y -= index->minimum;
    return dnaforge_inner_index_predecessor_slot(index, y);
}

static inline __attribute__((always_inline)) int64_t dnaforge_inner_index_previous(const dnaforge_inner_index_t *index, const mm128_t *a, int64_t i)
{
    int64_t previous = index->previous[i - index->begin];
    if (previous < 0 && index->coordinates)
        return dnaforge_inner_index_predecessor_slot(index, index->ranks[i - index->begin] - 1);
    return previous >= 0 ? previous : dnaforge_inner_index_predecessor(index, (int32_t)a[i].y - 1);
}

static lc_elem_t *dnaforge_inner_tree_rebuild(kmp_rmq_t *mp, const mm128_t *a, const int32_t *f, int64_t begin, int64_t end, float chn_pen_gap)
{
    lc_elem_t *root = 0;
    for (int64_t j = begin; j < end; ++j) {
        lc_elem_t *q = kmp_alloc_rmq(mp);
        q->y = (int32_t)a[j].y, q->i = j, q->pri = -(f[j] + 0.5 * chn_pen_gap * ((int32_t)a[j].x + (int32_t)a[j].y));
        krmq_insert(lc_elem, &root, q, 0);
    }
    return root;
}


static inline int32_t comput_sc_simple(const mm128_t *ai, const mm128_t *aj, float chn_pen_gap, float chn_pen_skip, int32_t *exact, int32_t *width)
{
	int32_t dq = (int32_t)ai->y - (int32_t)aj->y, dr, dd, dg, q_span, sc;
	dr = (int32_t)(ai->x - aj->x);
	*width = dd = dr > dq? dr - dq : dq - dr;
	dg = dr < dq? dr : dq;
	q_span = aj->y>>32&0xff;
	sc = q_span < dg? q_span : dg;
	if (exact) *exact = (dd == 0 && dg <= q_span);
	if (dd || dq > q_span) {
		float lin_pen, log_pen;
		lin_pen = chn_pen_gap * (float)dd + chn_pen_skip * (float)dg;
		log_pen = dd >= 1? mg_log2(dd + 1) : 0.0f; // mg_log2() only works for dd>=2
		sc -= (int)(lin_pen + .5f * log_pen);
	}
	return sc;
}

static inline __attribute__((always_inline)) int32_t dnaforge_comput_simple_cached_sc(const mm128_t *ai, const mm128_t *aj, float chn_pen_gap, float chn_pen_skip, int32_t *exact, int32_t *width, const int32_t *penalties, int bw)
{
    if (!penalties) return comput_sc_simple(ai, aj, chn_pen_gap, chn_pen_skip, exact, width);
    const int32_t dq = (int32_t)ai->y - (int32_t)aj->y;
    const int32_t dr = (int32_t)(ai->x - aj->x);
    const int32_t dd = dr > dq ? dr - dq : dq - dr;
    if (dd < 0 || dd > bw) return comput_sc_simple(ai, aj, chn_pen_gap, chn_pen_skip, exact, width);
    const int32_t dg = dr < dq ? dr : dq;
    const int32_t q_span = aj->y >> 32 & 0xff;
    *width = dd;
    if (exact) *exact = dd == 0 && dg <= q_span;
    const int32_t score = q_span < dg ? q_span : dg;
    return dd || dq > q_span ? score - penalties[dd] : score;
}

static inline __attribute__((always_inline)) int dnaforge_comput_simple_in_band(const mm128_t *ai, const mm128_t *aj, float chn_pen_gap, float chn_pen_skip, int32_t *exact, int32_t *width, const int32_t *penalties, int bw, int32_t *score)
{
    const int32_t dq = (int32_t)ai->y - (int32_t)aj->y;
    const int32_t dr = (int32_t)(ai->x - aj->x);
    const int32_t dd = dr > dq ? dr - dq : dq - dr;
    if (dd > bw) {
        *width = dd;
        if (exact) {
            const int32_t dg = dr < dq ? dr : dq;
            *exact = dd == 0 && dg <= (int32_t)(aj->y >> 32 & 0xff);
        }
        return 0;
    }
    *score = dnaforge_comput_simple_cached_sc(ai, aj, chn_pen_gap, chn_pen_skip, exact, width, penalties, bw);
    return 1;
}

static void dnaforge_rmq_score_range(dnaforge_chain_work_t *work, int64_t begin, int64_t end)
{
    const mm128_t *a = work->a;
    int32_t *f = work->f, *t = work->t, *v = work->v, mmax_f = 0, max_rmq_size = 0;
    int64_t *p = work->p, i, i0, st = begin, st_inner = begin, n = work->count;
    const int max_dist = work->max_dist_x, max_dist_inner = work->max_dist_inner;
    const int bw = work->bw, max_chn_skip = work->max_skip, cap_rmq_size = work->cap_rmq_size;
    const float chn_pen_gap = work->chn_pen_gap, chn_pen_skip = work->chn_pen_skip;
    lc_elem_t *root = 0, *root_inner = 0, *unique_minimum = 0;
    const int track_minimum = chn_pen_gap >= -FLT_MAX && chn_pen_gap <= FLT_MAX;
    if (!work->arena) work->arena = km_init2(0, 0x10000);
    void *mem_mp = km_init2(work->arena, 0x10000);
    kmp_rmq_t *mp = kmp_init_rmq(mem_mp);
    dnaforge_inner_index_t inner_index = dnaforge_inner_index_init(mem_mp, a, begin, end, max_dist_inner, cap_rmq_size);
	// fill the score and backtrack arrays
	for (i = i0 = begin; i < end; ++i) {
		int64_t max_j = -1;
		int32_t q_span = a[i].y>>32&0xff, max_f = q_span;
		lc_elem_t s, *q, *r, lo, hi;
		// add in-range anchors
		if (i0 < i && a[i0].x != a[i].x) {
			int64_t j;
			for (j = i0; j < i; ++j) {
				q = kmp_alloc_rmq(mp);
				q->y = (int32_t)a[j].y, q->i = j, q->pri = -(f[j] + 0.5 * chn_pen_gap * ((int32_t)a[j].x + (int32_t)a[j].y));
                if (track_minimum) {
                    if (!root || q->pri < root->head.s->pri) unique_minimum = q;
                    else if (q->pri == root->head.s->pri) unique_minimum = 0;
                }
				krmq_insert(lc_elem, &root, q, 0);
				if (max_dist_inner > 0) {
                    if (inner_index.enabled) {
                        if (!dnaforge_inner_index_insert(&inner_index, q->y, j)) {
                            inner_index.enabled = 0;
                            root_inner = dnaforge_inner_tree_rebuild(mp, a, f, st_inner, j + 1, chn_pen_gap);
                        }
                    } else {
                        r = kmp_alloc_rmq(mp);
                        *r = *q;
                        krmq_insert(lc_elem, &root_inner, r, 0);
                    }
				}
			}
			i0 = i;
		}
		// get rid of active chains out of range
		while (st < i && (a[i].x>>32 != a[st].x>>32 || a[i].x > a[st].x + max_dist || krmq_size(head, root) > cap_rmq_size)) {
			s.y = (int32_t)a[st].y, s.i = st;
			if (root && (q = krmq_erase(lc_elem, &root, &s, 0)) != 0) {
                if (q == unique_minimum) unique_minimum = 0;
				kmp_free_rmq(mp, q);
			}
			++st;
		}
		if (max_dist_inner > 0)  { // similar to the block above, but applied to the inner tree
			while (st_inner < i && (a[i].x>>32 != a[st_inner].x>>32 || a[i].x > a[st_inner].x + max_dist_inner || (inner_index.enabled ? inner_index.count : krmq_size(head, root_inner)) > cap_rmq_size)) {
				s.y = (int32_t)a[st_inner].y, s.i = st_inner;
                if (inner_index.enabled && !dnaforge_inner_index_erase(&inner_index, s.y, st_inner)) {
                    inner_index.enabled = 0;
                    root_inner = dnaforge_inner_tree_rebuild(mp, a, f, st_inner, i0, chn_pen_gap);
                }
                if (!inner_index.enabled && root_inner && (q = krmq_erase(lc_elem, &root_inner, &s, 0)) != 0) {
                    kmp_free_rmq(mp, q);
                }
				++st_inner;
			}
		}
		// RMQ
		lo.i = INT32_MAX, lo.y = (int32_t)a[i].y - max_dist;
		hi.i = 0, hi.y = (int32_t)a[i].y;
        q = unique_minimum && lc_elem_cmp(unique_minimum, &lo) >= 0 && lc_elem_cmp(unique_minimum, &hi) <= 0
            ? unique_minimum : krmq_rmq(lc_elem, root, &lo, &hi);
		if (q != 0) {
			int32_t sc, exact, width, n_skip = 0;
			int64_t j = q->i;
			assert(q->y >= lo.y && q->y <= hi.y);
            if (dnaforge_comput_simple_in_band(&a[i], &a[j], chn_pen_gap, chn_pen_skip, &exact, &width, work->penalties, bw, &sc)) {
                sc += f[j];
                if (sc > max_f) max_f = sc, max_j = j;
            }
            if (!exact && (inner_index.enabled ? inner_index.count > 0 : root_inner != 0) && (int32_t)a[i].y > 0) {
                const lc_elem_t *candidate;
                krmq_itr_t(lc_elem) itr;
                int available = 1;
                int64_t inner_j = -1;
                if (inner_index.enabled) inner_j = dnaforge_inner_index_predecessor(&inner_index, (int32_t)a[i].y - 1);
                else {
                    lc_elem_t *lower, *upper;
                    s.y = (int32_t)a[i].y - 1, s.i = n;
                    krmq_interval(lc_elem, root_inner, &s, &lower, &upper);
                    available = lower != 0;
                    if (available) krmq_itr_find(lc_elem, root_inner, lower, &itr);
                }
                while (available) {
                    int32_t width;
                    if (inner_index.enabled) {
                        if (inner_j < 0 || (int32_t)a[inner_j].y < (int32_t)a[i].y - max_dist_inner) break;
                        j = inner_j;
                    } else {
                        candidate = krmq_at(&itr);
                        if (!candidate || candidate->y < (int32_t)a[i].y - max_dist_inner) break;
                        j = candidate->i;
                    }
                        if (dnaforge_comput_simple_in_band(&a[i], &a[j], chn_pen_gap, chn_pen_skip, 0, &width, work->penalties, bw, &sc)) {
                            sc += f[j];
							if (sc > max_f) {
								max_f = sc, max_j = j;
								if (n_skip > 0) --n_skip;
							} else if (t[j] == (int32_t)i) {
								if (++n_skip > max_chn_skip)
									break;
							}
							if (p[j] >= 0) t[p[j]] = i;
						}
                    if (inner_index.enabled) inner_j = dnaforge_inner_index_previous(&inner_index, a, j);
                    else if (!krmq_itr_prev(lc_elem, &itr)) break;
                }
            }
		}
		// set max
		assert(max_j < 0 || (a[max_j].x < a[i].x && (int32_t)a[max_j].y < (int32_t)a[i].y));
		f[i] = max_f, p[i] = max_j;
        if (v) v[i] = dnaforge_chain_peak_at(f, p, v, i);
		if (mmax_f < max_f) mmax_f = max_f;
		if (max_rmq_size < krmq_size(head, root)) max_rmq_size = krmq_size(head, root);
	}
    km_destroy(mem_mp);
}

mm128_t *dnaforge_lchain_rmq_cached(int max_dist, int max_dist_inner, int bw, int max_chn_skip, int cap_rmq_size, int min_cnt, int min_sc, float chn_pen_gap, float chn_pen_skip,
					   int64_t n, mm128_t *a, int *n_u_, uint64_t **_u, void *km, dnaforge_chain_cache_t *cache)
{
	int32_t *f,*t, *v, n_u, n_v, max_drop = bw;
	int64_t *p;
	uint64_t *u;

	if (_u) *_u = 0, *n_u_ = 0;
	if (n == 0 || a == 0) {
		kfree(km, a);
		return 0;
	}
	if (max_dist < bw) max_dist = bw;
	if (max_dist_inner < 0) max_dist_inner = 0;
	if (max_dist_inner > max_dist) max_dist_inner = max_dist;
	p = Kmalloc(km, int64_t, n);
	f = Kmalloc(km, int32_t, n);
	t = Kcalloc(km, int32_t, n);
	v = 0;
    dnaforge_chain_work_t work = {
        .a = a, .f = f, .t = t, .v = v, .p = p, .cache = cache,
        .max_dist_x = max_dist, .max_dist_inner = max_dist_inner, .bw = bw,
        .max_skip = max_chn_skip, .cap_rmq_size = cap_rmq_size,
        .chn_pen_gap = chn_pen_gap, .chn_pen_skip = chn_pen_skip, .n_seg = 1
    };
    work.penalties = dnaforge_prepare_chain_penalties(&work);
    dnaforge_chain_score_all(&work, n, dnaforge_rmq_score_range);
    free(work.penalties);

	v = Kmalloc(km, int32_t, n);
	u = mg_chain_backtrack(km, n, f, p, v, t, min_cnt, min_sc, max_drop, &n_u, &n_v);
	*n_u_ = n_u, *_u = u; // NB: note that u[] may not be sorted by score here
	kfree(km, p); kfree(km, f); kfree(km, t);
	if (n_u == 0) {
		kfree(km, a); kfree(km, v);
		return 0;
	}
	return compact_a(km, n_u, u, n_v, v, a);
}

mm128_t *mg_lchain_rmq(int max_dist, int max_dist_inner, int bw, int max_chn_skip, int cap_rmq_size, int min_cnt, int min_sc, float chn_pen_gap, float chn_pen_skip,
					   int64_t n, mm128_t *a, int *n_u_, uint64_t **_u, void *km)
{
    return dnaforge_lchain_rmq_cached(max_dist, max_dist_inner, bw, max_chn_skip, cap_rmq_size, min_cnt, min_sc, chn_pen_gap, chn_pen_skip, n, a, n_u_, _u, km, 0);
}
