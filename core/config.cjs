'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_NAME = '.proof-of-green.json';
const USER_CONFIG_NAME = CONFIG_NAME;
const DEFAULT_EXIT_CODE_FIELD = 'exit_code';

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

const nonEmpty = (v) => typeof v === 'string' && v !== '';

function toTestTools(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (!nonEmpty(e.tool) || !nonEmpty(e.commandArg)) continue;
    // Only MCP tools: listing Bash, PowerShell or Edit would bypass their shell-specific rules.
    if (!e.tool.startsWith('mcp__')) continue;
    out.push({
      tool: e.tool,
      commandArg: e.commandArg,
      exitCodeField: nonEmpty(e.exitCodeField) ? e.exitCodeField : DEFAULT_EXIT_CODE_FIELD,
    });
  }
  return out;
}

const samePath = (a, b) => (process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

// Walks up from cwd to the git root (or only cwd without one) for the nearest project config.
function findProjectConfig(cwd) {
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
  return { file, root };
}

// Reports whether a config file exists, parses to an object, and how many testTools entries survive normalization.
function inspectConfigFile(file) {
  const out = { path: file, exists: false, valid: false, testTools: 0, skipped: 0 };
  if (!file || !fs.existsSync(file)) return out;
  out.exists = true;
  const data = readJson(file);
  if (!data) return out;
  out.valid = true;
  out.testTools = toTestTools(data.testTools).length;
  out.skipped = (Array.isArray(data.testTools) ? data.testTools.length : 0) - out.testTools;
  return out;
}

function loadConfig(cwd, env = process.env, homeDir = os.homedir()) {
  const { file, root } = findProjectConfig(cwd);
  const project = file ? readJson(file) : null;
  // A user file that is the project file is read once, as the project file.
  const userFile = path.join(path.resolve(homeDir), USER_CONFIG_NAME);
  const user = file && samePath(path.resolve(file), userFile) ? null : readJson(userFile);
  const off = String(env.PROOF_OF_GREEN || '').toLowerCase() === 'off';
  const enabled = project && typeof project.enabled === 'boolean'
    ? project.enabled
    : !(user && user.enabled === false);
  const pTools = toTestTools(project && project.testTools);
  const pNames = new Set(pTools.map((t) => t.tool));
  const both = (key) => [...strings(user && user[key]), ...strings(project && project[key])];
  return {
    enabled: !off && enabled,
    testPatterns: toRegExps(both('testCommands')),
    include: both('include'),
    exclude: both('exclude'),
    testTools: [...toTestTools(user && user.testTools).filter((t) => !pNames.has(t.tool)), ...pTools],
    root,
  };
}

module.exports = { loadConfig, findProjectConfig, inspectConfigFile, CONFIG_NAME, USER_CONFIG_NAME };
