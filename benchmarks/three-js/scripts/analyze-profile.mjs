#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let tracePath;
const filters = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--filter') {
    const value = args[++i];
    if (!value) {
      console.error('Missing value after --filter');
      process.exit(1);
    }

    filters.push(value);
    continue;
  }

  if (!tracePath) {
    tracePath = arg;
  } else {
    console.error('Unexpected argument:', arg);
    console.error('Usage: node analyze-profile.mjs <trace-file> [--filter <substring>]...');
    process.exit(1);
  }
}

if (!tracePath) {
  console.error('Usage: node analyze-profile.mjs <trace-file> [--filter <substring>]...');
  process.exit(1);
}
let raw = await fs.promises.readFile(tracePath, 'utf8');
let trimmed = raw.trim();
if (!trimmed.endsWith(']')) {
  trimmed += ']';
}
const events = JSON.parse(trimmed);
const cpuEvents = events.filter((event) => event.name === 'CpuProfile');

if (cpuEvents.length === 0) {
  console.error('No CpuProfile events found in trace');
  process.exit(1);
}

for (const event of cpuEvents) {
  const {cpuProfile} = event.args.data;
  const nodes = new Map();
  const parentByChild = new Map();

  for (const node of cpuProfile.nodes) {
    nodes.set(node.id, node);
    if (node.children) {
      for (const childId of node.children) {
        parentByChild.set(childId, node.id);
      }
    }
  }

  const selfTimes = new Map();
  const samples = cpuProfile.samples || [];
  const timeDeltas = cpuProfile.timeDeltas || [];

  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const delta = timeDeltas[i] || 0;
    selfTimes.set(nodeId, (selfTimes.get(nodeId) || 0) + delta);
  }

  const inclusiveTimes = new Map();
  const visited = new Set();

  function computeInclusive(nodeId) {
    if (visited.has(nodeId)) {
      return inclusiveTimes.get(nodeId) || 0;
    }

    visited.add(nodeId);
    let total = selfTimes.get(nodeId) || 0;
    const node = nodes.get(nodeId);
    if (node && node.children) {
      for (const childId of node.children) {
        total += computeInclusive(childId);
      }
    }
    inclusiveTimes.set(nodeId, total);
    return total;
  }

  for (const nodeId of nodes.keys()) {
    if (!parentByChild.has(nodeId)) {
      computeInclusive(nodeId);
    }
  }

  const aggregateByUrl = new Map();
  const aggregateByFunction = new Map();
  const aggregateByCaller = new Map();
  const normalisedFilters = filters.map((filter) => filter.toLowerCase());
  const filterActive = normalisedFilters.length > 0;
  let filteredSelfDuration = 0;

  function normaliseUrl(url) {
    if (!url) {
      return '(anonymous)';
    }

    if (url.startsWith('file://')) {
      return path.normalize(url.replace('file://', ''));
    }

    if (url.startsWith('internal/')) {
      return `(internal) ${url}`;
    }

    if (/^\w+:/.test(url)) {
      return url;
    }

    return path.normalize(url);
  }

  function matchesFilters(url, fn) {
    if (!filterActive) {
      return true;
    }

    const haystack = `${url || ''}::${fn || ''}`.toLowerCase();
    return normalisedFilters.some((filter) => haystack.includes(filter));
  }

  for (const [nodeId, node] of nodes.entries()) {
    const callFrame = node.callFrame || {};
    const url = normaliseUrl(callFrame.url);
    const fn = callFrame.functionName || '(anonymous)';
    const self = selfTimes.get(nodeId) || 0;
    const total = inclusiveTimes.get(nodeId) || 0;

    if (!matchesFilters(url, fn)) {
      continue;
    }

    filteredSelfDuration += self;

    if (!aggregateByUrl.has(url)) {
      aggregateByUrl.set(url, {self: 0, total: 0});
    }
    const urlEntry = aggregateByUrl.get(url);
    urlEntry.self += self;
    urlEntry.total += total;

    if (!aggregateByFunction.has(fn)) {
      aggregateByFunction.set(fn, {self: 0, total: 0, url});
    }
    const fnEntry = aggregateByFunction.get(fn);
    fnEntry.self += self;
    fnEntry.total += total;

    const parentId = parentByChild.get(nodeId);
    let callerName = '(root)';
    if (parentId != null) {
      const parentNode = nodes.get(parentId);
      const parentFrame = parentNode?.callFrame || {};
      const parentFn = parentFrame.functionName || '(anonymous)';
      const parentUrl = normaliseUrl(parentFrame.url);
      callerName = `${parentFn} (${parentUrl})`;
    }

    if (!aggregateByCaller.has(callerName)) {
      aggregateByCaller.set(callerName, {self: 0, total: 0});
    }

    const callerEntry = aggregateByCaller.get(callerName);
    callerEntry.self += self;
    callerEntry.total += total;
  }

  const totalDuration = timeDeltas.reduce((sum, delta) => sum + delta, 0);
  const factor = 0.001; // convert microseconds -> milliseconds

  function printTop(title, entries, key) {
    const sorted = Array.from(entries.entries())
      .map(([name, data]) => ({name, ...data}))
      .sort((a, b) => b[key] - a[key])
      .slice(0, 15);

    console.log(`\nTop ${key === 'total' ? 'inclusive' : 'self'} times by ${title}`);
    for (const entry of sorted) {
      const reference = key === 'total' ? Math.min(entry[key], totalDuration) : entry[key];
      const share = totalDuration === 0 ? 0 : (reference / totalDuration) * 100;
      const ms = entry[key] * factor;
      let line = `${ms.toFixed(1)}ms (${share.toFixed(1)}%)`;

      if (filterActive && key === 'self' && filteredSelfDuration > 0) {
        const filteredShare = (entry[key] / filteredSelfDuration) * 100;
        line += ` [${filteredShare.toFixed(1)}% of filtered self]`;
      }

      line += ` - ${entry.name}${entry.url ? ` (${entry.url})` : ''}`;

      console.log(line);
    }
  }

  console.log(`\nProfile: ${event.args.data.cpuProfile && event.args.data.cpuProfile.nodes ? event.args.data.cpuProfile.nodes.length : 0} nodes`);
  console.log(`Total sampled time: ${(totalDuration * factor).toFixed(1)}ms`);

  if (filterActive) {
    console.log(`Applied filters: ${filters.join(', ')}`);
    const filteredShare =
      totalDuration === 0 ? 0 : (filteredSelfDuration / totalDuration) * 100;
    console.log(
      `Filtered self time: ${(filteredSelfDuration * factor).toFixed(1)}ms (${filteredShare.toFixed(1)}% of sampled self time)`,
    );
  }

  printTop('file/url', aggregateByUrl, 'total');
  printTop('file/url', aggregateByUrl, 'self');
  printTop('function', aggregateByFunction, 'total');
  printTop('function', aggregateByFunction, 'self');
  if (filterActive) {
    printTop('caller', aggregateByCaller, 'total');
    printTop('caller', aggregateByCaller, 'self');
  }
}
