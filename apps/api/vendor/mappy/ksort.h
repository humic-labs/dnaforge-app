/* The MIT License

   Copyright (c) 2008, 2011 Attractive Chaos <attractor@live.co.uk>

   Permission is hereby granted, free of charge, to any person obtaining
   a copy of this software and associated documentation files (the
   "Software"), to deal in the Software without restriction, including
   without limitation the rights to use, copy, modify, merge, publish,
   distribute, sublicense, and/or sell copies of the Software, and to
   permit persons to whom the Software is furnished to do so, subject to
   the following conditions:

   The above copyright notice and this permission notice shall be
   included in all copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
   BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
   ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   SOFTWARE.
*/

// This is a simplified version of ksort.h

#ifndef AC_KSORT_H
#define AC_KSORT_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

typedef struct {
	void *left, *right;
	int depth;
} ks_isort_stack_t;

#define KSORT_SWAP(type_t, a, b) { type_t t=(a); (a)=(b); (b)=t; }

#define KSORT_INIT(name, type_t, __sort_lt) \
	void ks_heapdown_##name(size_t i, size_t n, type_t l[]) \
	{ \
		size_t k = i; \
		type_t tmp = l[i]; \
		while ((k = (k << 1) + 1) < n) { \
			if (k != n - 1 && __sort_lt(l[k], l[k+1])) ++k; \
			if (__sort_lt(l[k], tmp)) break; \
			l[i] = l[k]; i = k; \
		} \
		l[i] = tmp; \
	} \
	void ks_heapmake_##name(size_t lsize, type_t l[]) \
	{ \
		size_t i; \
		for (i = (lsize >> 1) - 1; i != (size_t)(-1); --i) \
			ks_heapdown_##name(i, lsize, l); \
	} \
	type_t ks_ksmall_##name(size_t n, type_t arr[], size_t kk)			\
	{																	\
		type_t *low, *high, *k, *ll, *hh, *mid;							\
		low = arr; high = arr + n - 1; k = arr + kk;					\
		for (;;) {														\
			if (high <= low) return *k;									\
			if (high == low + 1) {										\
				if (__sort_lt(*high, *low)) KSORT_SWAP(type_t, *low, *high); \
				return *k;												\
			}															\
			mid = low + (high - low) / 2;								\
			if (__sort_lt(*high, *mid)) KSORT_SWAP(type_t, *mid, *high); \
			if (__sort_lt(*high, *low)) KSORT_SWAP(type_t, *low, *high); \
			if (__sort_lt(*low, *mid)) KSORT_SWAP(type_t, *mid, *low);	\
			KSORT_SWAP(type_t, *mid, *(low+1));							\
			ll = low + 1; hh = high;									\
			for (;;) {													\
				do ++ll; while (__sort_lt(*ll, *low));					\
				do --hh; while (__sort_lt(*low, *hh));					\
				if (hh < ll) break;										\
				KSORT_SWAP(type_t, *ll, *hh);							\
			}															\
			KSORT_SWAP(type_t, *low, *hh);								\
			if (hh <= k) low = ll;										\
			if (hh >= k) high = hh - 1;									\
		}																\
	}																	\

#define ks_ksmall(name, n, a, k) ks_ksmall_##name(n, a, k)

#define ks_lt_generic(a, b) ((a) < (b))
#define ks_lt_str(a, b) (strcmp((a), (b)) < 0)

typedef const char *ksstr_t;

#define KSORT_INIT_GENERIC(type_t) KSORT_INIT(type_t, type_t, ks_lt_generic)
#define KSORT_INIT_STR KSORT_INIT(str, ksstr_t, ks_lt_str)

#define RS_MIN_SIZE 64
#define RS_MAX_BITS 8

#define KRADIX_SORT_INIT(name, rstype_t, rskey, sizeof_key) \
	typedef struct { \
		rstype_t *b, *e; \
	} rsbucket_##name##_t; \
	void rs_insertsort_##name(rstype_t *beg, rstype_t *end) \
	{ \
		rstype_t *i; \
		for (i = beg + 1; i < end; ++i) \
			if (rskey(*i) < rskey(*(i - 1))) { \
				rstype_t *j, tmp = *i; \
				for (j = i; j > beg && rskey(tmp) < rskey(*(j-1)); --j) \
					*j = *(j - 1); \
				*j = tmp; \
			} \
	} \
	static inline __attribute__((always_inline)) int rs_partition_##name(rstype_t *beg, rstype_t *end, int n_bits, int s, rsbucket_##name##_t *b, int *child_shift) \
	{ \
		rstype_t *i; \
		uint64_t first_key, varying; \
		int size = 1<<n_bits, m = size - 1; \
		rsbucket_##name##_t *k, *be = b + size; \
		assert(n_bits <= RS_MAX_BITS); \
		*child_shift = -1; \
		if (end - beg < 2) return -1; \
		first_key = (uint64_t)rskey(*beg); \
		for (;;) { \
			varying = 0; \
			for (k = b; k != be; ++k) k->b = k->e = beg; \
			for (i = beg; i != end; ++i) { \
				uint64_t key = (uint64_t)rskey(*i); \
				++b[key>>s&m].e; varying |= key ^ first_key; \
			} \
			if (!varying) return -1; \
			if (!s || (varying >> s) != 0) break; \
			s = s > n_bits ? s - n_bits : 0; \
			while (s && (varying >> s) == 0) s = s > n_bits ? s - n_bits : 0; \
		} \
		if (s && (varying & ((1ULL << s) - 1))) { \
			*child_shift = s > n_bits ? s - n_bits : 0; \
			while (*child_shift && ((varying >> *child_shift) & m) == 0) \
				*child_shift = *child_shift > n_bits ? *child_shift - n_bits : 0; \
		} \
		for (k = b + 1; k != be; ++k) \
			k->e += (k-1)->e - beg, k->b = (k-1)->e; \
		for (k = b; k != be;) { \
			if (k->b != k->e) { \
				rsbucket_##name##_t *l; \
				if ((l = b + (rskey(*k->b)>>s&m)) != k) { \
					rstype_t tmp = *k->b, swap; \
					do { \
						swap = tmp; tmp = *l->b; *l->b++ = swap; \
						l = b + (rskey(tmp)>>s&m); \
					} while (l != k); \
					*k->b++ = tmp; \
				} else ++k->b; \
			} else ++k; \
		} \
		for (b->b = beg, k = b + 1; k != be; ++k) k->b = (k-1)->e; \
		return s; \
	} \
	void rs_sort_##name(rstype_t *beg, rstype_t *end, int n_bits, int s) \
	{ \
		rsbucket_##name##_t b[1<<RS_MAX_BITS], *k, *be = b + (1<<n_bits); \
		int child_shift; \
		s = rs_partition_##name(beg, end, n_bits, s, b, &child_shift); \
		if (s < 0) return; \
		if (s && child_shift >= 0) { \
			s = child_shift; \
			for (k = b; k != be; ++k) \
				if (k->e - k->b > RS_MIN_SIZE) rs_sort_##name(k->b, k->e, n_bits, s); \
				else if (k->e - k->b > 1) rs_insertsort_##name(k->b, k->e); \
		} \
	} \
	void radix_sort_##name(rstype_t *beg, rstype_t *end) \
	{ \
		if (end - beg <= RS_MIN_SIZE) rs_insertsort_##name(beg, end); \
		else rs_sort_##name(beg, end, RS_MAX_BITS, (sizeof_key - 1) * RS_MAX_BITS); \
	}

#endif
