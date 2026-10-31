'use strict';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const ERROR_PREFIX = /^\s*Error:\s*/;

// Returns { value, isError }: text prefixed "Error: " is an error result whose rest is parsed.
function parseText(text) {
  if (ERROR_PREFIX.test(text)) return { value: JSON.parse(text.replace(ERROR_PREFIX, '')), isError: true };
  return { value: JSON.parse(text), isError: false };
}

function responseValue(response) {
  if (Array.isArray(response)) {
    const block = response.find((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string');
    return block ? parseText(block.text) : { value: undefined, isError: false };
  }
  if (typeof response === 'string') return parseText(response);
  return { value: response, isError: false };
}

function walk(value, field) {
  let cur = value;
  for (const key of field.split('.')) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function readToolExitCode(response, field = 'exit_code') {
  try {
    if (typeof field !== 'string') return 'unknown';
    let { value, isError } = responseValue(response);
    // An MCP CallToolResult wrapper: an error result is never a pass, and the payload sits
    // in the first text block of `content`.
    if (isObject(value) && (value.isError === true || value.is_error === true)) return 'fail';
    let code = walk(value, field);
    if (code === undefined && isObject(value) && Array.isArray(value.content)) {
      const inner = responseValue(value.content);
      code = walk(inner.value, field);
      isError = isError || inner.isError;
    }
    const isInt = Number.isInteger(code) || (typeof code === 'string' && /^-?\d+$/.test(code));
    if (!isInt) return 'unknown';
    // A result reported as an error is never a pass, even with exit code 0.
    return Number(code) === 0 && !isError ? 'pass' : 'fail';
  } catch {
    return 'unknown';
  }
}

module.exports = { readToolExitCode };
