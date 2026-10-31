'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readToolExitCode } = require('../core/toolresult.cjs');

const textBlock = (text) => ({ type: 'text', text });

test('array text block with exit_code 0 passes, nonzero fails', () => {
  assert.equal(readToolExitCode([textBlock('{"exit_code":0}')]), 'pass');
  assert.equal(readToolExitCode([textBlock('{"exit_code":1}')]), 'fail');
});

test('real Claude Code response shape fails on exit_code 1', () => {
  const text = '{"exit_code":1,"duration_sec":0.05,"stdout":"FAIL","stderr":""}';
  assert.equal(readToolExitCode([textBlock(text)]), 'fail');
});

test('plain string is parsed as JSON', () => {
  assert.equal(readToolExitCode('{"exit_code":2}'), 'fail');
});

test('object is used directly without parsing', () => {
  assert.equal(readToolExitCode({ exit_code: 0 }), 'pass');
});

test('dotted path walks nested objects', () => {
  assert.equal(readToolExitCode('{"result":{"code":0}}', 'result.code'), 'pass');
  assert.equal(readToolExitCode('{"result":{"code":3}}', 'result.code'), 'fail');
  assert.equal(readToolExitCode('{"result":5}', 'result.code'), 'unknown');
});

test('exit code value forms', () => {
  assert.equal(readToolExitCode({ exit_code: '0' }), 'pass');
  assert.equal(readToolExitCode({ exit_code: '-1' }), 'fail');
  assert.equal(readToolExitCode({ exit_code: '0.5' }), 'unknown');
  assert.equal(readToolExitCode({ exit_code: true }), 'unknown');
  assert.equal(readToolExitCode({ exit_code: null }), 'unknown');
  assert.equal(readToolExitCode({ exit_code: 0.5 }), 'unknown');
});

test('unreadable text or missing field is unknown', () => {
  assert.equal(readToolExitCode('not json'), 'unknown');
  assert.equal(readToolExitCode([textBlock('not json')]), 'unknown');
  assert.equal(readToolExitCode({ other: 0 }), 'unknown');
  assert.equal(readToolExitCode([]), 'unknown');
  assert.equal(readToolExitCode([{ type: 'image', data: 'x' }]), 'unknown');
});

test('only the first text block is read', () => {
  assert.equal(readToolExitCode([textBlock('not json'), textBlock('{"exit_code":0}')]), 'unknown');
  assert.equal(readToolExitCode([{ type: 'image' }, textBlock('{"exit_code":0}')]), 'pass');
});

test('odd inputs are unknown and never throw', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(readToolExitCode(undefined), 'unknown');
  assert.equal(readToolExitCode(42), 'unknown');
  assert.equal(readToolExitCode(null), 'unknown');
  assert.equal(readToolExitCode(circular), 'unknown');
  assert.equal(readToolExitCode({ exit_code: 0 }, undefined), 'pass');
  assert.equal(readToolExitCode({ exit_code: 0 }, 42), 'unknown');
});

const wrapper = (code, extra = {}) => ({ content: [textBlock(JSON.stringify({ exit_code: code }))], ...extra });

test('CallToolResult wrapper reads the field from its first text block', () => {
  assert.equal(readToolExitCode(wrapper(0)), 'pass');
  assert.equal(readToolExitCode(wrapper(1)), 'fail');
});

test('an isError result is a fail even when its text says exit_code 0', () => {
  assert.equal(readToolExitCode(wrapper(0, { isError: true })), 'fail');
  assert.equal(readToolExitCode(wrapper(0, { is_error: true })), 'fail');
  assert.equal(readToolExitCode({ isError: true, content: [textBlock('connection refused')] }), 'fail');
});

test('a JSON string of a CallToolResult wrapper is handled the same way', () => {
  assert.equal(readToolExitCode(JSON.stringify(wrapper(0))), 'pass');
  assert.equal(readToolExitCode(JSON.stringify(wrapper(1))), 'fail');
  assert.equal(readToolExitCode(JSON.stringify(wrapper(0, { isError: true }))), 'fail');
});
