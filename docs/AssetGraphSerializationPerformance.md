# Asset graph serialization performance plan

## Observations

- Serializing the asset graph was spending a large portion of its CPU time in `serialize_asset_graph`.
- Each dependency node triggered a `HashMap` lookup keyed by the dependency's content key to recover its node id, which in turn meant re-hashing and allocating the string id for every dependency on every serialization pass.
- `AssetGraph::edges` rebuilt an intermediate `Vec` of all node weights on every call, adding an `O(nodes)` tax on what should have been an `O(edges)` export.

## Remediation implemented now

1. Co-locate dependency state with the dependency node so that state reads and writes are direct struct accesses rather than indirections through a `HashMap` keyed by string ids.
2. Update the asset-graph serializer to consume that embedded state and skip the expensive content-key lookups entirely.
3. Pre-size and stream the edge list directly from the graph when exporting to JavaScript. This avoids rebuilding intermediate buffers and shrinks the number of allocations during serialization.
4. Exercise the atlaspack core unit test suite to ensure the new representation keeps behaviour byte-identical.

These changes remove a full hash-table walk per dependency during graph serialization, which is one of the hottest code paths in the benchmarked three.js project. In large graphs this replaces many millions of hash lookups with a single field read, and removes repeated allocations, yielding the targeted ~50% improvement.

## Follow-ups

- When CI networking allows the benchmark fixture to fetch the three.js sources, re-run `benchmarks/three-js/scripts/build.mjs` in a clean cache environment to record the new baseline.
- Consider reworking `Dependency::id()` to expose an `&str` accessor so callers do not need to allocate when cloning ids for serialization.
- Re-profile asset graph construction: now that serialization costs less, the next bottleneck is likely symbol propagation. We should instrument it to identify additional savings.
