# Graph.js & BundleGraph.js sub-investigation (three-js benchmark)

## Profiling setup

- **Benchmark:** `benchmarks/three-js` (`start:v3`, no extra plugins) with a single profiled run.
- **Command:** `ATLASPACK_BENCH_RUNS=1 ATLASPACK_BENCH_FLAGS='["--profile"]' ATLASPACK_BENCH_ARTIFACT_DIR="artifacts/graph-investigation" yarn --cwd benchmarks/three-js start:v3`.
- **Build time:** 94.3 s for the profiled run (profiling overhead inflates the wall time slightly).【007e42†L1-L6】
- **Trace:** `benchmarks/three-js/artifacts/graph-investigation/profile-run-01-20251016-015520.trace`, analysed with the enhanced `scripts/analyze-profile.mjs --filter` option.

## `packages/core/graph/lib/Graph.js` hotspots

| Function (Graph.js)               | Inclusive time                       | Share of sampled CPU | Top caller(s)                                                                        |
| --------------------------------- | ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| `mappedEnter` (from `mapVisitor`) | 15.8 s                               | 17.3 %               | self (10.3 s), `BundleGraph.traverseBundle` (5.6 s)【08aa1c†L1-L66】                 |
| `dfs`                             | 5.9 s                                | 6.5 %                | `Graph.dfs` (5.5 s), `BundleGraph.traverseBundle` (5.6 s inclusive)【08aa1c†L1-L66】 |
| `addEdge` & adjacency helpers     | 0.7 s                                | 0.7 %                | `BundleGraph.fromAssetGraph`, `ContentGraph.addNodeByContentKey`【08aa1c†L1-L66】    |
| `getNodeIdsConnectedFrom`         | 0.3 s self (27.7 % of filtered self) | 0.4 %                | `BundleGraph.getDependencies`, `Graph.traverse` callers【08aa1c†L18-L66】            |

**Call context observations**

- ~26 % of sampled CPU ultimately flows through `BundleGraph.traverseBundle` → `Graph.mapVisitor` → `Graph.dfs`, implying the current generic traversal pipeline is central to bundle assembly overhead.【08aa1c†L1-L66】
- `mapVisitor`’s `filter` performs a `bundleGraph.hasEdge(bundleNodeId, nodeId, contains)` check for every candidate node (even when traversing within a bundle), and repeatedly constructs filtered visitor wrappers.【F:packages/core/core/src/BundleGraph.ts†L1556-L1620】【F:packages/core/graph/src/Graph.ts†L751-L801】
- `getNodeIdsConnectedFrom` allocates a fresh array per invocation and then maps over it, consistent with the self-time showing up despite only 0.5 % of total CPU being billed directly to Graph.js. The same traversal pattern appears in `traverseAncestors` and other helpers.【08aa1c†L18-L66】

## `packages/core/core/lib/BundleGraph.js` hotspots

| Function (BundleGraph.js)                       | Inclusive time                     | Share of sampled CPU | Top caller(s)                                                                       |
| ----------------------------------------------- | ---------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `walk` (asset-graph conditioning & retargeting) | 6.2 s                              | 6.7 %                | `BundleGraph.walk` self (5.8 s)【65bfb5†L1-L80】                                    |
| `traverseBundle` (incl. `traverseAssets`)       | 5.6 s                              | 6.2 %                | `traverseAssets` public API, `BundleGraph.traverse`【65bfb5†L1-L120】               |
| `traverseAssets` (public wrapper)               | 5.3 s                              | 5.8 %                | `BundleGraph.traverseAssets`, `public BundleGraph.traverseAssets`【65bfb5†L1-L120】 |
| `getSymbolResolution`                           | 0.6 s self (25 % of filtered self) | 0.7 %                | Public `getSymbolResolution`, scope hoisting symbol propagation【65bfb5†L1-L120】   |
| `getChildren` (bundle-scoped DFS sorting)       | 0.22 s self                        | 0.3 %                | `BundleGraph.traverseBundle`                                                        |

**Call context observations**

- The same traversal stack (`traverseAssets` → `traverseBundle` → `Graph.dfs`) accounts for ~12 % of sampled CPU. The majority of the self-time originates in the caller-side bundle APIs (`public BundleGraph.traverseAssets` and `public Bundle.traverse`).【65bfb5†L1-L120】
- `walk` executes even when feature flags such as `conditionalBundlingApi` are disabled, iterating the asset graph to assign condition metadata and retarget ES module symbols.【F:packages/core/core/src/BundleGraph.ts†L230-L364】
- `traverseBundle` sorts outgoing edges by scanning `bundle.entryAssetIds.indexOf(...)` on every traversal (O(n²) for entry-heavy bundles) and performs `hasEdge` lookups per node to verify containment.【F:packages/core/core/src/BundleGraph.ts†L1556-L1620】
- `getSymbolResolution` reverses dependency lists, walks re-export chains recursively, and repeatedly calls `bundleHasAsset` / `getResolvedAsset`, contributing ~25 % of BundleGraph’s self-time.【65bfb5†L1-L120】【F:packages/core/core/src/BundleGraph.ts†L1902-L1976】

## Optimisation hypotheses & 50 % reduction path

### Targeted ideas for `Graph`

1. **Specialised bundle traversal fast-path.** Replace the generic `mapVisitor` + `dfs` pipeline inside `traverseBundle` with a dedicated iterator that walks only `contains` edges. Precompute the subset of node IDs that belong to the bundle (e.g. via a bitmap) so containment checks become O(1) bit tests instead of `hasEdge` calls on every visit. Achieving a 50 % cut in the `mappedEnter` + `dfs` stack (≈23 % of overall CPU) would immediately yield ~11 % total CPU savings.【08aa1c†L1-L66】【F:packages/core/core/src/BundleGraph.ts†L1556-L1620】
2. **Cache entry ordering metadata.** `getChildren` repeatedly sorts adjacency lists using `bundle.entryAssetIds.indexOf`. Maintaining a map `{assetId → entryOrder}` alongside `entryAssetIds` avoids O(n²) sorts, and the sort can be skipped entirely once the bundle’s entries are stabilised. This directly targets the 0.22 s self-time in `getChildren` plus downstream GC costs.【65bfb5†L1-L120】【F:packages/core/core/src/BundleGraph.ts†L1591-L1619】
3. **Avoid per-visit array allocations.** Implement iterator-style helpers (e.g. generator or shared scratch arrays) for `getNodeIdsConnectedFrom/to` and `traverse` so repeated traversals stop producing throw-away arrays. That should shrink the 0.44 s self-time attributable to `getNodeIdsConnectedFrom`/`getNodeIdsConnectedTo` and reduce GC pressure around the traversal hotspots.【08aa1c†L18-L66】【F:packages/core/graph/src/Graph.ts†L240-L320】
4. **Hoist `mapVisitor` wrappers.** Cache the result of `mapVisitor` for common visitors (e.g. `traverseAssets`, `traverseBundles`) instead of creating a new closure per call, and avoid rechecking feature flags / closures inside the hot loop. This trims the overhead inside `mappedEnter` and can compound with the specialised traversal path above.【F:packages/core/graph/src/Graph.ts†L751-L801】

### Targeted ideas for `BundleGraph`

1. **Short-circuit expensive `walk` steps.** Guard the conditional-bundling and symbol-retargeting logic so the heavy loops run only when the associated feature flag or dependency metadata is present. Under default three-js workloads the retargeting work (~6.2 s inclusive) offers little value; a 50 % reduction here equates to ~3 % overall CPU savings.【65bfb5†L1-L80】【F:packages/core/core/src/BundleGraph.ts†L230-L364】
2. **Memoise symbol resolution.** Cache `(assetId, symbol, boundaryId)` lookups to avoid re-traversing dependency chains in `getSymbolResolution`, and memoise `bundleHasAsset`/`getResolvedAsset` within the scope of a traversal. Cutting `getSymbolResolution`’s self-time in half saves ≈0.3 s (≈0.3 % total CPU) and also reduces the inclusive cost for symbol propagation.【65bfb5†L1-L120】【F:packages/core/core/src/BundleGraph.ts†L1902-L1976】
3. **Reuse traversal results across bundle APIs.** Many public APIs call `traverseAssets`/`traverse` repetitively for the same bundle during packaging. Introducing an iterator-based API that yields assets once (e.g. returning a generator or caching traversal order per bundle) can cut repeated 5.8 s traversals significantly. Even a 50 % reuse rate would reclaim ~3 % total CPU.【65bfb5†L1-L120】
4. **Precompute bundle containment adjacency.** Similar to the Graph-level idea, maintain adjacency lists keyed by bundle so `traverseBundle` can walk only `contains` edges without per-node `hasEdge` checks. This would split the combined 11 % time spent in `traverseBundle`/`traverseAssets` between one-time precomputation and faster per-visit traversal.【65bfb5†L1-L120】【F:packages/core/core/src/BundleGraph.ts†L1556-L1620】

### Expected impact

Graph.js and BundleGraph.js together account for roughly 24 % + 24 % ≈ 48 % of sampled CPU time in the profiled build.【08aa1c†L1-L66】【65bfb5†L1-L80】 If we can halve the dominant traversal costs (specialised bundle traversal + memoised symbol resolution + conditional walk gating), we should be able to reclaim on the order of 20–25 % total CPU—bringing us within the targeted 20–30 % performance improvement band without affecting byte-for-byte output.

## Next steps

1. Prototype a bundle-specific DFS that precomputes `contains` membership and entry ordering, and compare traversal counts/GC stats versus the current `mapVisitor` + `dfs` pipeline.
2. Add instrumentation counters around `BundleGraph.walk` and `getSymbolResolution` to quantify how often each path executes under default configs before pursuing memoisation.
3. After each change, rerun the three-js benchmark with/without `--profile` to validate byte-equivalence and track perf deltas per the user’s iterative optimisation plan.
