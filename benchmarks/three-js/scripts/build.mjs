/* eslint-disable no-console */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as url from 'node:url';
import * as module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {printTable} from '@oclif/table';
import chalk from 'chalk';

const THREE_JS_BRANCH = process.env.THREE_JS_BRANCH || 'r108';
const THREE_JS_REPO_URL =
  process.env.THREE_JS_REPO_URL || 'https://github.com/mrdoob/three.js.git';

let headers = 0;

const MODE = process.env.ATLASPACK_BENCH_MODE;
if (MODE === undefined) {
  console.error('env:ATLASPACK_BENCH_MODE not specified');
  console.error('  options:');
  console.error('    * V2');
  console.error('    * V3');
  process.exit(1);
}

const PLUGINS = process.env.ATLASPACK_BENCH_PLUGINS
  ? parseInt(process.env.ATLASPACK_BENCH_PLUGINS, 10)
  : 10;

const COPIES =
  process.env.ATLASPACK_BENCH_COPIES !== undefined
    ? parseInt(process.env.ATLASPACK_BENCH_COPIES, 10)
    : 30;

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const benchDir = path.normalize(path.join(__dirname, '..'));
const vendorDir = path.join(benchDir, 'three-js');

const RUNS = process.env.ATLASPACK_BENCH_RUNS
  ? parseInt(process.env.ATLASPACK_BENCH_RUNS, 10)
  : 10;

const EXTRA_FLAGS = process.env.ATLASPACK_BENCH_FLAGS
  ? parseFlags(process.env.ATLASPACK_BENCH_FLAGS)
  : [];

const ARTIFACT_DIR = process.env.ATLASPACK_BENCH_ARTIFACT_DIR
  ? path.resolve(benchDir, process.env.ATLASPACK_BENCH_ARTIFACT_DIR)
  : null;

async function main() {
  writeHeader('Settings');

  const settings = [
    {
      key: 'mode',
      value: chalk.green(`'${MODE}'`),
    },
    {
      key: 'plugins',
      value: chalk.yellow(PLUGINS),
    },
    {
      key: 'copies',
      value: chalk.yellow(COPIES),
    },
    {
      key: 'runs',
      value: chalk.yellow(RUNS),
    },
  ];

  if (EXTRA_FLAGS.length > 0) {
    settings.push({
      key: 'extraFlags',
      value: chalk.cyan(EXTRA_FLAGS.join(' ')),
    });
  }

  if (ARTIFACT_DIR) {
    settings.push({
      key: 'artifactDir',
      value: chalk.cyan(ARTIFACT_DIR),
    });
  }

  printTable({
    columns: [
      {key: 'key', name: 'Key      '},
      {
        key: 'value',
        name: 'Value     ',
      },
    ],
    data: settings,
    headerOptions: {
      formatter: 'capitalCase',
    },
  });

  writeHeader('Setup');

  // Atlaspack fails to build in the current directory because it is getting
  // settings from the workspace package.json. To get around this, this script
  // copies the benchmark to a temporary directory and links Atlaspack in
  let tmpDir;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlaspack-bench'));
  } catch (error) {
    console.error('Failed to create temp directory for benchmark', error);
    process.exit(1);
  }

  console.log('Created temporary directory', tmpDir);

  try {
    // Copy files to a temporary directory
    console.log('Copying benchmark...');

    await Promise.all([
      rmrf(path.join(benchDir, 'dist')),
      rmrf(path.join(benchDir, '.parcel-cache')),
    ]);

    await fs.cp(benchDir, tmpDir, {recursive: true});
    await rmrf(path.join(tmpDir, 'node_modules'));

    const [packageJson, parcelRc] = await Promise.all([
      readJson(path.join(tmpDir, 'package.json')),
      readJson(path.join(tmpDir, '.parcelrc')),
    ]);

    // Patch the package.json to link the files to the workspace files
    const require = module.createRequire(import.meta.url);
    for (const dependency of Object.keys(packageJson.dependencies)) {
      if (!dependency.startsWith('@atlaspack')) continue;
      const resolved = require.resolve(path.join(dependency, 'package.json'));
      packageJson.dependencies[dependency] = `file:${path.dirname(resolved)}`;
    }

    // Patch .parcelrc to include plugins
    for (let i = 0; i < PLUGINS; i++) {
      await fs.cp(
        path.join(__dirname, '..', 'plugins', 'transformer.js'),
        path.join(tmpDir, 'plugins', `transformer_${i}.js`),
      );

      await fs.cp(
        path.join(__dirname, '..', 'plugins', 'resolver.js'),
        path.join(tmpDir, 'plugins', `resolver_${i}.js`),
      );

      parcelRc['transformers']['*.{js,mjs,jsm,jsx,es6,cjs,ts,tsx}'].unshift(
        `./plugins/transformer_${i}.js`,
      );

      parcelRc['resolvers'].unshift(`./plugins/resolver_${i}.js`);
    }

    await Promise.all([
      writeJson(path.join(tmpDir, 'package.json'), packageJson),
      writeJson(path.join(tmpDir, '.parcelrc'), parcelRc),
    ]);

    // Get three-js
    if (!fsSync.existsSync(vendorDir)) {
      console.log('Pulling three-js...');
      fetchThreeJs();
    }

    // Copy three-js to bench directory
    console.log('Copying sources...');

    const code = [];
    const copies = [];
    const imports = [];

    for (let i = 0; i < COPIES; i++) {
      copies.push(
        fs.cp(
          path.join(benchDir, 'three-js', 'src'),
          path.join(tmpDir, 'src', `copy-${i}`),
          {
            recursive: true,
          },
        ),
      );

      imports.push(`import * as three_js_${i} from './copy-${i}/Three.js';`);
      code.push(`globalThis['three_js_${i}'] = three_js_${i};`);
    }

    const setupTasks = [
      ...copies,
      fs.appendFile(
        path.join(tmpDir, 'src', 'index.js'),
        [...imports, ...code].join('\n'),
        'utf8',
      ),
    ];

    if (ARTIFACT_DIR) {
      setupTasks.push(fs.mkdir(ARTIFACT_DIR, {recursive: true}));
    }

    await Promise.all(setupTasks);

    // Link node_modules
    console.log('Linking node_modules...');
    child_process.execFileSync('npm', ['install'], {
      cwd: tmpDir,
      shell: true,
      stdio: 'inherit',
    });

    // Start the benchmark
    writeHeader('Running');

    const buildTimes = [];

    for (let i = 0; i < RUNS; i++) {
      const startTime = Date.now();

      // Atlaspack must be run in it's own process
      // because it currently cannot be spawned multiple times in the same process
      try {
        child_process.execFileSync(
          'npx',
          [
            'atlaspack',
            'build',
            '--no-autoinstall',
            '--no-cache',
            '--dist-dir=./dist',
            ...(MODE === 'V3' ? ['--feature-flag', 'atlaspackV3=true'] : []),
            './src/index.js',
            ...EXTRA_FLAGS,
          ],
          {
            cwd: tmpDir,
            stdio: 'inherit',
          },
        );
      } catch (error) {
        return;
      }

      const buildTime = Date.now() - startTime;
      console.log(`Build ${i + 1}: ${buildTime}ms`);
      buildTimes.push(buildTime);

      if (ARTIFACT_DIR) {
        await collectArtifacts(tmpDir, ARTIFACT_DIR, i + 1);
      }

      await rmrf(path.join(tmpDir, '.parcel-cache'));
      await rmrf(path.join(tmpDir, 'dist'));
    }

    const average =
      buildTimes.reduce((total, time) => total + time, 0) / buildTimes.length;

    console.log(`Benchmarks completed with an average time of ${average}ms`);

    await writeJson(path.join(benchDir, 'report.json'), {
      average,
      buildTimes,
    });
  } catch (err) {
    console.error(err);
  } finally {
    await rmrf(tmpDir);
  }
}

main();

function parseFlags(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((flag) => typeof flag === 'string')) {
      return parsed;
    }

    throw new Error('expected an array of strings');
  } catch (error) {
    console.error('Failed to parse ATLASPACK_BENCH_FLAGS:', error);
    process.exit(1);
  }
}

async function collectArtifacts(tmpDir, artifactDir, runNumber) {
  const metricsSource = path.join(tmpDir, 'parcel-metrics.json');
  const metricsTarget = path.join(
    artifactDir,
    `parcel-metrics-run-${String(runNumber).padStart(2, '0')}.json`,
  );

  await copyIfExists(metricsSource, metricsTarget);

  let entries = [];
  try {
    entries = await fs.readdir(tmpDir);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('profile-') && entry.endsWith('.trace'))
      .map(async (entry) => {
        const targetName = entry.replace(
          /^profile-/,
          `profile-run-${String(runNumber).padStart(2, '0')}-`,
        );

        await copyIfExists(
          path.join(tmpDir, entry),
          path.join(artifactDir, targetName),
        );
      }),
  );
}

async function copyIfExists(source, destination) {
  try {
    await fs.copyFile(source, destination);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function fetchThreeJs() {
  child_process.execFileSync(
    'git',
    [
      'clone',
      '--depth=1',
      '--branch',
      THREE_JS_BRANCH,
      THREE_JS_REPO_URL,
      vendorDir,
    ],
    {
      stdio: 'inherit',
      shell: true,
    },
  );
}

function rmrf(target) {
  return fs.rm(target, {force: true, recursive: true});
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

function writeJson(target, data) {
  return fs.writeFile(target, JSON.stringify(data, null, 2));
}

function writeHeader(header) {
  if (headers > 1) {
    console.log('');
  }
  console.log(chalk.bold.cyan.underline(header.toUpperCase()));
  if (headers > 0) {
    console.log('');
  }
  headers += 1;
}
