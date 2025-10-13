# Atlaspack Synthetic Benchmark Harness

This crate generates deterministic JavaScript projects that stress Atlaspack's
build pipeline without requiring access to external repositories. The projects
are intentionally deep and wide to exercise module graph traversal, optimizer
passes, and packager bookkeeping at scale.

## Usage

```bash
cargo run -p atlaspack_benchmark -- generate --out /tmp/atlaspack-synth --modules 50000 --fanout 3 --clean
```

The generator writes the following layout:

- `package.json` – minimal manifest so Node treats the project as ESM.
- `atlaspack-benchmark.json` – metadata describing module count and fanout.
- `src/index.js` – entry module that eagerly executes the dependency tree.
- `src/module_XXXXX.js` – generated dependency graph with deterministic imports.

Run Atlaspack against the generated sources by pointing the CLI at the entry
module and explicitly selecting the repository's default config:

```bash
node packages/core/cli/src/bin.js build /tmp/atlaspack-synth/src/index.js \
  --config packages/configs/default/index.json --no-cache --dist-dir /tmp/atlaspack-synth/dist
```

Delete `dist` and `.parcel-cache` between runs to emulate cold-cache CI builds.
