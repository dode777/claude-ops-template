#!/usr/bin/env node
// 템플릿 자체 시험 — test/*.test.js 를 차례로 돌리고, 하나라도 실패하면 1.
//   node test/run.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
const failed = [];
for (const f of files) {
  console.log(`\n━━ ${f}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}
console.log(`\n시험 ${files.length}개 중 ${files.length - failed.length}개 통과${failed.length ? ` — 실패: ${failed.join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
