#!/usr/bin/env node
// 템플릿 저장소에서 바로 부르는 입구 — 본체는 payload/.claude/ops/bin/claude-ops.js 하나다(소비자에도 그 파일이 들어간다).
//   node <템플릿 체크아웃>/bin/claude-ops.js init --source <템플릿 URL> --ref latest   (docs/ADOPT.md)
'use strict';
const ops = require('../payload/.claude/ops/bin/claude-ops.js');
try { process.exitCode = ops.main(process.argv.slice(2)); } catch (e) {
  process.stderr.write(`[claude-ops] ${e.message}\n`); process.exitCode = 1;
}
