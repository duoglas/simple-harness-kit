'use strict';

const MARKER_RE = /^\[shk-runtime-result\]\s+status=(PASS|DEGRADED|SKIP)\s*$/gm;

function runtimeResultClass(output) {
  let status = null;
  let match;
  const text = String(output || '');
  while ((match = MARKER_RE.exec(text)) !== null) status = match[1];
  MARKER_RE.lastIndex = 0;
  if (status === 'PASS') return 'passed';
  if (status === 'SKIP') return 'skipped';
  return 'degraded';
}

module.exports = { runtimeResultClass };
