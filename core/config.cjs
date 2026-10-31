'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_NAME = '.proof-of-green.json';

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

function toRegExps(list) {
  const out = [];
  for (const s of strings(list)) {
    try { out.push(new RegExp(s)); } catch { /* invalid regex: skip */ }
  }
  return out;
}

function loadConfig(cwd, env = process.env) {
  const start = path.resolve(cwd);
  let dir = start;
  let root = start;
  let file = null;
  let gitFound = false;
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (!file && fs.existsSync(candidate)) file = candidate;
    if (fs.existsSync(path.join(dir, '.git'))) { root = dir; gitFound = true; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Without a git root nothing bounds the walk, so only cwd's own config counts.
  if (!gitFound) {
    const own = path.join(start, CONFIG_NAME);
    file = fs.existsSync(own) ? own : null;
  }
  const data = file ? readJson(file) : null;
  const off = String(env.PROOF_OF_GREEN || '').toLowerCase() === 'off';
  return {
    enabled: !off && !(data && data.enabled === false),
    testPatterns: toRegExps(data && data.testCommands),
    include: strings(data && data.include),
    exclude: strings(data && data.exclude),
    root,
  };
}

module.exports = { loadConfig, CONFIG_NAME };
