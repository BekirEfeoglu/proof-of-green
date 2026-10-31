'use strict';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function responseValue(response) {
  if (Array.isArray(response)) {
    const block = response.find((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string');
    return block ? JSON.parse(block.text) : undefined;
  }
  if (typeof response === 'string') return JSON.parse(response);
  return response;
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
    const value = responseValue(response);
    // An MCP CallToolResult wrapper: an error result is never a pass, and the payload sits
    // in the first text block of `content`.
    if (isObject(value) && (value.isError === true || value.is_error === true)) return 'fail';
    let code = walk(value, field);
    if (code === undefined && isObject(value) && Array.isArray(value.content)) {
      code = walk(responseValue(value.content), field);
    }
    const isInt = Number.isInteger(code) || (typeof code === 'string' && /^-?\d+$/.test(code));
    if (!isInt) return 'unknown';
    return Number(code) === 0 ? 'pass' : 'fail';
  } catch {
    return 'unknown';
  }
}

module.exports = { readToolExitCode };
