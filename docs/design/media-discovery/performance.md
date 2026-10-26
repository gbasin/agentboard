# Media discovery measurements

Measured on 2026-10-26 on the development Mac. These are observations, not latency guarantees. Filesystem caches were warm; SQLite indexes were fresh. No physical iPhone or cellular timing is claimed.

The reported session initially comprised 116 transcript files totaling 522,236,093 bytes. The previous pipeline spent 783 ms extracting PRs and 1,628 ms indexing media before publishing results. Indexed page reads took 2 ms. No crash or minute-long stall reproduced.

The later progressive run found 119 files totaling 562,367,276 bytes, because the live session continued growing. It produced the first committed item in 32 ms and the first independent read-only page in 33 ms. Completion took 4,337 ms across 473 cooperative steps. The largest step took 70 ms; page reads took at most 5 ms. Peak RSS was 235,487,232 bytes (about 225 MiB). Final counts were 734 items: 471 images and 263 links.

The inputs differ, so these are not fixed-input total-speed comparisons. The redesign improves time to usable results and isolates reads; it does not claim to make a full scan faster. One complete JSONL record can exceed the 12 ms cooperative slice target.

Real-worker regression separately places a 48 MiB indivisible record in the writer and verifies a cached page resolves before that writer completes. Compiled HTTP measurements and exact commands appear in compiled-validation.md. Private indexes and transcript copies are not included in the repository.

## Frozen-source repeat

The reusable harness is `bun scripts/benchmark-media-discovery.ts /path/to/claude-session.jsonl`. It reads the supplied transcript and discovered child files, writes only a disposable private index, emits aggregate measurements, and removes its temporary directory.

The final repeat used 119 files totaling 565,091,456 bytes. First media page: 31.0 ms. Completion: 4,367.7 ms over 467 steps. Largest step: 292.2 ms. Largest page read: 4.5 ms. RSS at completion: 206,159,872 bytes (not a peak measurement). Final counts: 754 items, including 471 images and 283 links.

This run overlapped browser and regression testing. Its larger maximum step reinforces that cooperative slicing is not a hard scheduling guarantee. Independent-reader regression and compiled HTTP checks establish isolation separately.
