# Performance checks

`just verify` builds the production desktop assets, then tests and runs the initial JS budget check. No additional packages are needed.

`node scripts/performance/bundle-budget.mjs apps/desktop/dist --json` emits the initial static-import graph, individual gzip level 9 sizes, all manifest chunks and the +20% budget against P4-1's 369794 bytes. Missing or ambiguous entry/dependency fails instead of undercounting. Dynamic imports are excluded from the initial graph, but listed in all chunks. This is a per-file compression comparison, not wire transfer size.

Native macOS sampling is separate: see `docs/acceptance/p4-21.md` and the temporary Inspector sampler. Never run frame measurements alongside builds/tests. JavaScript rAF and double-rAF input samples approximate scheduling/paint opportunity, not compositor FPS or guaranteed visible paint. No timings from jsdom are used as native performance proof.
