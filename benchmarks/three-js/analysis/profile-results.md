# Three-js Benchmark Profiling Summary (Atlaspack V3, no plugins)

## Benchmark setup

- **Mode:** V3 (`ATLASPACK_BENCH_MODE=V3`)
- **Plugins:** 0 additional plugins (`ATLASPACK_BENCH_PLUGINS=0`)
- **Copies:** 30 copies of the three.js sources (default script behaviour)
- **Runs:** 1 profiling run (`ATLASPACK_BENCH_RUNS=1`)
- **Extra CLI flags:** `--profile`
- **Artifact capture:** `ATLASPACK_BENCH_ARTIFACT_DIR=artifacts/latest-profile`

The benchmark averaged **~108.3 s** on the profiled cold run (single measurement, profiling adds overhead).【F:benchmarks/three-js/report.json†L1-L6】【a776d7†L1-L5】

> Note: enabling `@atlaspack/reporter-build-metrics` causes the CLI to abort with `ENOENT: .../index` while attempting to open `index` inside the temporary benchmark directory.【7ce73f†L1-L11】 This prevented collecting `parcel-metrics.json` phase timings.

## CPU profile highlights

The captured CPU trace was analysed with `scripts/analyze-profile.mjs`, producing the summary in `analysis/profile-summary.txt`.
Key observations (inclusive/self time percentages are relative to sampled CPU time):

- **Scope hoisting packager** dominates CPU usage, accounting for ~78% of inclusive time and ~1.9% self time within the packager implementation.【F:benchmarks/three-js/analysis/profile-summary.txt†L7-L24】 This suggests the packaging stage (tree shaking, scope hoisting) is the single largest hotspot.
- **Graph maintenance** (`Graph.js`, `BundleGraph.js`, `ContentGraph.js`, `AdjacencyList.js`) collectively consume a significant share of both inclusive and self CPU time, highlighting graph traversal and bookkeeping costs.【F:benchmarks/three-js/analysis/profile-summary.txt†L9-L27】
- **Symbol propagation** and **SWC optimizer** each contribute ~7–8% inclusive time, indicating the transformer/optimizer pipeline remains costly even without extra plugins.【F:benchmarks/three-js/analysis/profile-summary.txt†L13-L20】
- **LMDB-backed cache interactions** appear on the hot list (~8% inclusive, ~0.3% self), implying I/O or serialization overhead during cache reads/writes.【F:benchmarks/three-js/analysis/profile-summary.txt†L12-L28】
- Large portions of sampled time are reported as `(idle)` or `(anonymous)` (runtime bookkeeping, worker idling) because the profile spans both master and worker threads; actual work happens in bursts amid scheduling/IPC overhead.【F:benchmarks/three-js/analysis/profile-summary.txt†L1-L40】【F:benchmarks/three-js/analysis/profile-summary.txt†L41-L58】

## Supporting tooling

- Added `scripts/analyze-profile.mjs` to parse Atlaspack trace files and emit aggregated per-file and per-function timing tables. The script tolerates truncated trace JSON and can be rerun on future traces.【F:benchmarks/three-js/scripts/analyze-profile.mjs†L1-L137】
- Stored the textual summary at `analysis/profile-summary.txt` for reference alongside this report.【F:benchmarks/three-js/analysis/profile-summary.txt†L1-L58】

## Next steps / potential investigations

1. **Scope hoisting optimisation:** investigate ways to reduce repeated traversal in `ScopeHoistingPackager` (e.g. caching symbol resolution, batch operations) since it dominates CPU usage.
2. **Graph operations:** profile individual graph APIs (BundleGraph mutations, ContentGraph updates) to determine whether data structure changes or memoization could cut costs.
3. **SWC optimizer & symbol propagation:** measure whether reducing transformation passes or batching SWC invocations yields meaningful savings.
4. **Cache interactions:** explore whether LMDB read/write patterns during builds can be streamlined (e.g. fewer round-trips, larger batched transactions).
5. **Build metrics reporter bug:** fix the `ENOENT` crash so phase timing data (`parcel-metrics.json`) can be captured and correlated with CPU hotspots.
