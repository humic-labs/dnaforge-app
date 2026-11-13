# Gibson Assembly Implementation Guide

This document explains how the Gibson assembly primer design works in this
codebase, with a focus on homology regions and primer overhangs.

## Overview: What the Homology Region Represents

```
Composed Sequence (80bp example):
Position: 0         10        20        30    33    40        50        60        70        80
          |         |         |         |     |     |         |         |         |         |
          AAAAAAAAAAAAAAAAAAAAGGGGGGGGGGGGGGGGGGGGCCCCCCCCCCCCCCCCCCCCTTTTTTTTTTTTTTTTTTTT
          |<----------- Fragment 1 (0-39) --------->|<---------- Fragment 2 (40-79) ------->|
                                               |<-- homology region -->|
                                               33                      48
                                               |<-onLeft->|<--onRight->|
                                                  (7bp)       (8bp)
```

The homology region is the overlapping sequence that enables Gibson assembly to
join two fragments. It is SPLIT into two portions:

- **onLeft**: bases BEFORE the junction position (from the upstream fragment's
  3' end)
- **onRight**: bases AFTER the junction position (from the downstream fragment's
  5' start)

## How Primers Provide Homology

The key insight is that the homology region is SPLIT between two primers at each
junction:

| Primer | Overhang Sequence | What it represents                              |
| ------ | ----------------- | ----------------------------------------------- |
| F2-fwd | `GGGGGGG` (7bp)   | Positions 33-39 (left portion, direct copy)     |
| F1-rev | `GGGGGGGG` (8bp)  | RC of positions 40-47 (right portion, as oligo) |

**IMPORTANT**: The overhangs do NOT need to be reverse complements of each
other!

## PCR Products (Double-Stranded)

### Fragment 1 PCR Product

```
Watson: 5'-AAAA...AAAA-GGGG...GGGG-3'        (positions 0-39, ends at position 39)
                      └──────────┘
                       last 7bp = positions 33-39 = GGGGGGG

Crick:  3'-TTTT...TTTT-CCCC...CCCC-GGGGGGGG-5'
                                   └───────┘
                                   overhang (= RC of positions 40-47)
                                   extends Crick 5' past Watson 3'
```

The F1-rev primer overhang becomes the 5' end of the Crick strand, extending it
past the Watson strand's 3' end.

### Fragment 2 PCR Product

```
Watson: 5'-GGGGGGG-CCCC...CCCC-TTTT...TTTT-3'
           └──────┘
           overhang (= positions 33-39)
           extends Watson 5' past Crick 3'

Crick:  3'-       -GGGG...GGGG-AAAA...AAAA-5'
                   └─────────────────────────┘
                   complement of positions 40-79
```

The F2-fwd primer overhang becomes the 5' end of the Watson strand, extending it
past the Crick strand's 3' end.

## Gibson Assembly Mechanism

### Step 1: T5 Exonuclease Chews 5' Ends

T5 exonuclease specifically degrades 5' ends of double-stranded DNA, exposing 3'
single-stranded overhangs.

**On F1 at junction end (right side):**

```
Before:  Watson: ...GGGGGGG-3'           (positions 33-39)
         Crick:  ...CCCCCCC-GGGGGGGG-5'  (overhang at 5')
                            ^^^^^^^^
                            T5 chews this

After:   Watson: ...GGGGGGG-3'  <<< 3' overhang EXPOSED
         Crick:  ...CCC    -5'      (chewed back)
```

**On F2 at junction end (left side):**

```
Before:  Watson: 5'-GGGGGGG-CCCCCCCC...
                    ^^^^^^^
                    T5 chews this
         Crick:  3'-       -GGGGGGGG...

After:   Watson: 5'-       -CCCCCCCC...  (chewed back)
         Crick:  3'-CCCCCCC-GGGGGGGG...  <<< 3' overhang EXPOSED
```

### Step 2: Complementary 3' Ends Anneal

The exposed 3' single-stranded regions are complementary and anneal:

```
                        G pairs with C!
                              |
F1 Watson 3': ...GGGGGGG-3'  ═══════
                  |||||||
F2 Crick  3':  3'-CCCCCCC... ═══════
```

These are antiparallel and complementary - they anneal via hydrogen bonding!

### Step 3: Polymerase + Ligase Complete the Assembly

- Phusion polymerase fills in the single-stranded gaps
- Taq ligase seals the nicks
- Result: seamlessly joined fragments

## Summary of Component Roles

| Component                     | Sequence                     | Role in Gibson                          |
| ----------------------------- | ---------------------------- | --------------------------------------- |
| F1 template (positions 0-39)  | Contains pos 33-39 at 3' end | Provides left homology after T5 chewing |
| F1-rev overhang               | `GGGGGGGG` = RC(pos 40-47)   | Extends F1 Crick 5' with right homology |
| F2-fwd overhang               | `GGGGGGG` = pos 33-39        | Extends F2 Watson 5' with left homology |
| F2 template (positions 40-79) | Contains pos 40-47 at 5' end | Right homology is in template           |

## Key Relationships

The overlapping region (homology) spans positions 33-47 (15bp total), and is
represented:

- **In F1 PCR product**: pos 33-39 from template + pos 40-47 via overhang on
  Crick
- **In F2 PCR product**: pos 33-39 via overhang on Watson + pos 40-47 from
  template

### What the Overhangs ARE and ARE NOT

**The overhangs are NOT reverse complements of each other:**

- F1-rev overhang: `GGGGGGGG` (RC of right homology portion)
- F2-fwd overhang: `GGGGGGG` (left homology portion directly)

**What actually anneals (after T5 chewing):**

- F1 Watson 3' exposed = last bases of F1 template = positions 33-39 = `GGGGGGG`
- F2 Crick 3' exposed = complement of F2-fwd overhang = `CCCCCCC`
- These ARE complementary and anneal!

## Implementation Details

### Homology Region Encoding

In the code, each `HomologyRegion` has:

```typescript
{
  junctionIndex: number,      // Which junction (0, 1, 2, ...)
  junctionPosition: number,   // Position in composed sequence where junction occurs
  start: number,              // Start of homology region in composed sequence
  end: number,                // End of homology region in composed sequence
  encoding: {
    onLeft: number,           // Bases before junction (from upstream fragment)
    onRight: number,          // Bases after junction (from downstream fragment)
  }
}
```

### Primer Overhang Computation

For a junction between Fragment N and Fragment N+1:

- **Fragment N reverse primer**:
  - Overhang = RC of `onRight` portion of homology
  - This extends Fragment N's Crick strand to include the right homology

- **Fragment N+1 forward primer**:
  - Overhang = `onLeft` portion of homology (direct, not RC)
  - This extends Fragment N+1's Watson strand to include the left homology

### Verification Test

See `gibson-understanding.test.ts` for a step-by-step trace through the
implementation that verifies these relationships.

---

## Gibson Assembly WITH Spacers

When a spacer is added at a junction, the composed sequence changes and the
homology region expands to include the spacer.

### Example: 10bp Spacer at Junction 0

```
Composed Sequence (74bp):
Position: 0         10        20    31 32    40 41 42    50    60    70 73
          |         |         |     |  |     |  |  |     |     |     |  |
          ATGCATGCATGCATGCATGCATGCATGCATGCAAAAAAAAAAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA
          |<-------- Fragment 1 (0-31) ------>||<--spacer-->||<----- Fragment 2 (42-73) ----->|
                                          |<-------- homology region -------->|
                                          31                                  54
                                          |<-onLeft->|<------onRight-------->|
                                             (11bp)          (12bp)
```

### Homology Region with Spacer

- **Junction position**: 42 (where F2 template starts)
- **Homology start**: 31 (1bp before spacer = last base of F1)
- **Homology end**: 54
- **onLeft**: 11bp (positions 31-41 = 1bp F1 + 10bp spacer)
- **onRight**: 12bp (positions 42-53 = first 12bp of F2)

### Primer Overhangs with Spacer

| Primer | Overhang                        | What it represents                       |
| ------ | ------------------------------- | ---------------------------------------- |
| F1-rev | `TAGCTAGCTAGCTTTTTTTTTT` (22bp) | RC of positions 32-53 (spacer + onRight) |
| F2-fwd | `CAAAAAAAAAA` (11bp)            | positions 31-41 (1bp F1 end + spacer)    |

**IMPORTANT**: The overhangs do NOT need to be reverse complements of each
other! They represent DIFFERENT portions of the homology region.

### How Spacer Enables Gibson Assembly

Both PCR products contain the spacer region, but on different strands:

**F1 PCR Product:**

```
Watson: 5'-[F1 template: pos 0-31]-3'
Crick:  3'-[complement of 0-31]-[spacer RC]-[F2 start RC]-5'
                                 TTTTTTTTTT  TAGCTAGCTAGC
                                 └─────── overhang ───────┘
```

**F2 PCR Product:**

```
Watson: 5'-[1bp F1]-[spacer]-[F2 template: pos 42-73]-3'
           C        AAAAAAAAAA
           └── overhang ──┘
Crick:  3'-                -[complement of 42-73]-5'
```

### Overlap Region with Spacer

The overlap region (positions 31-53) has complementary sequences:

| Position       | F1 strand            | F2 strand             | Relationship              |
| -------------- | -------------------- | --------------------- | ------------------------- |
| 31             | Watson (C)           | Watson (C)            | Same base (seamless join) |
| 32-41 (spacer) | Crick (TTTTTTTTTT)   | Watson (AAAAAAAAAA)   | Complementary!            |
| 42-53          | Crick (TAGCTAGCTAGC) | Watson (GCTAGCTAGCTA) | Complementary!            |

After T5 exonuclease chews 5' ends:

- F1's Crick 5' (the overhang) gets partially chewed, exposing ssDNA
- F2's Watson 5' (the overhang) gets partially chewed, exposing ssDNA
- The complementary ssDNA regions anneal in the spacer + F2 start region

### Spacer Sequence in Each Primer

The spacer appears in both primers:

- **F1-rev overhang**: Contains `TTTTTTTTTT` = RC(spacer)
- **F2-fwd overhang**: Contains `AAAAAAAAAA` = spacer

Both `spacerSequence` fields in the primer objects store the spacer as it
appears in that specific oligo (RC for reverse primer, direct for forward
primer).

### Verification

See `spacer-verification.test.ts` for tests that verify:

1. PBS sequences match expected positions in the composed sequence
2. Overhang sequences are correctly computed (including spacer)
3. The spacer is present in both primers at the junction
4. The spacer portions are complementary (enabling Gibson annealing)
