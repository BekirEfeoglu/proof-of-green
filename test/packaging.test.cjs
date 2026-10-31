'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../gate.cjs');

const ROOT = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const pkg = readJson('package.json');
const plugin = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const hooks = readJson('hooks/hooks.json');

const handlers = [];
for (const [name, groups] of Object.entries(hooks.hooks)) {
  for (const group of groups) {
    for (const handler of group.hooks) handlers.push({ name, group, handler });
  }
}

// An accepted event reaches the adapter, which throws under PROOF_OF_GREEN_TEST_THROW
// and gets logged; an unknown event returns early and logs nothing.
function gateAccepts(event) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-pack-'));
  try {
    const env = { CLAUDE_PLUGIN_DATA: data, PROOF_OF_GREEN_TEST_THROW: '1' };
    main(['claude', event], JSON.stringify({ session_id: 's1' }), env);
    return fs.existsSync(path.join(data, 'ledgers', 'errors.log'));
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
}

test('plugin and marketplace names match package.json', () => {
  assert.equal(plugin.name, pkg.name);
  assert.equal(marketplace.name, pkg.name);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.owner.name, 'Bekir Efeoğlu');
});

test('plugin version and license match package.json', () => {
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, pkg.license);
});

test('hooks.json declares the four gate events with the right matchers', () => {
  const summary = {};
  for (const { name, group, handler } of handlers) {
    summary[name] = { matcher: group.matcher, event: handler.args[2] };
  }
  assert.deepEqual(summary, {
    UserPromptSubmit: { matcher: undefined, event: 'user-prompt' },
    PostToolUse: { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', event: 'post-tool' },
    PostToolUseFailure: { matcher: 'Bash|PowerShell', event: 'post-tool-failure' },
    Stop: { matcher: undefined, event: 'stop' },
  });
});

test('every handler is an exec-form node command with a timeout', () => {
  assert.equal(handlers.length, 4);
  for (const { handler } of handlers) {
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'node');
    assert.equal(handler.timeout, 10);
    assert.equal(handler.args[1], 'claude');
  }
});

test('every handler script exists after substituting CLAUDE_PLUGIN_ROOT', () => {
  for (const { handler } of handlers) {
    const script = handler.args[0].replace('${CLAUDE_PLUGIN_ROOT}', ROOT);
    assert.ok(fs.existsSync(script), `missing ${script}`);
  }
});

test('every handler event is accepted by the gate', () => {
  assert.equal(gateAccepts('definitely-not-an-event'), false, 'probe must detect unknown events');
  for (const { handler } of handlers) {
    assert.ok(gateAccepts(handler.args[2]), `gate rejects ${handler.args[2]}`);
  }
});
