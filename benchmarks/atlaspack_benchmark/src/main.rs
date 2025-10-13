use std::{
  collections::BTreeMap,
  fs,
  io::Write,
  path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Cli {
  #[command(subcommand)]
  command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
  /// Generate a synthetic JavaScript project for Atlaspack benchmarks.
  Generate(GenerateCommand),
}

#[derive(Args, Debug)]
struct GenerateCommand {
  /// Directory where the synthetic project should be created.
  #[arg(long)]
  out: PathBuf,

  /// Number of JavaScript modules to generate.
  #[arg(long, default_value_t = 50_000)]
  modules: usize,

  /// Number of forward imports that each module should declare.
  #[arg(long, default_value_t = 3)]
  fanout: usize,

  /// Remove the output directory before generating files.
  #[arg(long)]
  clean: bool,
}

fn main() -> Result<()> {
  let cli = Cli::parse();
  match cli.command {
    Commands::Generate(cmd) => generate(cmd),
  }
}

fn generate(cmd: GenerateCommand) -> Result<()> {
  if cmd.modules == 0 {
    anyhow::bail!("module count must be greater than zero");
  }

  if cmd.fanout == 0 {
    anyhow::bail!("fanout must be at least one");
  }

  if cmd.clean && cmd.out.exists() {
    fs::remove_dir_all(&cmd.out)
      .with_context(|| format!("failed to clean output directory {}", cmd.out.display()))?;
  }

  fs::create_dir_all(&cmd.out)
    .with_context(|| format!("failed to create output directory {}", cmd.out.display()))?;

  let src_dir = cmd.out.join("src");
  fs::create_dir_all(&src_dir)
    .with_context(|| format!("failed to create src directory {}", src_dir.display()))?;

  write_package_json(&cmd)?;
  write_metadata(&cmd)?;
  write_index(&src_dir)?;

  for module_index in 0..cmd.modules {
    let module_path = src_dir.join(format!("module_{module_index:05}.js"));
    write_module(&module_path, module_index, cmd.modules, cmd.fanout)?;
  }

  Ok(())
}

fn write_package_json(cmd: &GenerateCommand) -> Result<()> {
  let mut manifest = BTreeMap::new();
  manifest.insert(
    "name",
    serde_json::Value::String("atlaspack-synthetic-benchmark".into()),
  );
  manifest.insert("version", serde_json::Value::String("1.0.0".into()));
  manifest.insert("private", serde_json::Value::Bool(true));
  manifest.insert("type", serde_json::Value::String("module".into()));

  let content = serde_json::to_vec_pretty(&manifest)?;
  fs::write(cmd.out.join("package.json"), content).context("failed to write package.json")?;
  Ok(())
}

fn write_metadata(cmd: &GenerateCommand) -> Result<()> {
  let mut metadata = BTreeMap::new();
  metadata.insert("modules", serde_json::Value::from(cmd.modules));
  metadata.insert("fanout", serde_json::Value::from(cmd.fanout));

  fs::write(
    cmd.out.join("atlaspack-benchmark.json"),
    serde_json::to_vec_pretty(&metadata)?,
  )
  .context("failed to write metadata")?;
  Ok(())
}

fn write_index(src_dir: &Path) -> Result<()> {
  let entry_path = src_dir.join("index.js");
  let mut entry = fs::File::create(&entry_path)
    .with_context(|| format!("failed to create {}", entry_path.display()))?;

  writeln!(entry, "import module00000 from './module_00000.js';")?;
  writeln!(entry, "")?;
  writeln!(entry, "export function runBenchmark() {{")?;
  writeln!(entry, "  return module00000();")?;
  writeln!(
    entry,
    "}}
"
  )?;
  writeln!(entry, "const result = runBenchmark();")?;
  writeln!(entry, "if (typeof globalThis !== 'undefined') {{")?;
  writeln!(entry, "  globalThis.__ATLASPACK_SYNTH_RESULT__ = result;")?;
  writeln!(entry, "}} else if (typeof window !== 'undefined') {{")?;
  writeln!(entry, "  window.__ATLASPACK_SYNTH_RESULT__ = result;")?;
  writeln!(
    entry,
    "}}
"
  )?;
  writeln!(entry, "export default result;")?;
  Ok(())
}

fn write_module(path: &Path, index: usize, total: usize, fanout: usize) -> Result<()> {
  let mut file = fs::File::create(path)
    .with_context(|| format!("failed to create module {}", path.display()))?;

  let mut imports = Vec::new();
  for offset in 1..=fanout {
    let target = index
      .checked_mul(fanout)
      .and_then(|base| base.checked_add(offset))
      .filter(|t| *t < total);
    if let Some(target) = target {
      imports.push(target);
    }
  }

  for target in &imports {
    writeln!(
      file,
      "import module{target:05} from './module_{target:05}.js';"
    )?;
  }

  writeln!(file, "")?;
  writeln!(file, "export default function module{index:05}() {{")?;
  writeln!(file, "  let value = {index};")?;
  for target in &imports {
    writeln!(file, "  value += module{target:05}();")?;
  }
  writeln!(file, "  return value;")?;
  writeln!(
    file,
    "}}
"
  )?;
  writeln!(file, "export const MODULE_ID = {index};")?;
  writeln!(
    file,
    "export const MODULE_DEPENDENCIES = [{}];",
    imports
      .iter()
      .map(|d| d.to_string())
      .collect::<Vec<_>>()
      .join(", ")
  )?;

  Ok(())
}
