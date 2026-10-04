#!/usr/bin/env node
// ci/run-shards.js — 테스트 명령들을 묶음(샤드)으로 나눠 돌린다. 실패해도 끝까지 돌고, 스크립트별 시간을 남긴다.
//
//   node ci/run-shards.js --config ci/shards.json --shard 2/3
//   node ci/run-shards.js --config ci/shards.json --all
//   node ci/run-shards.js --config ci/shards.json --list
//
// 설정(JSON):
//   {
//     "fromPackageJson": ["test", "test:e2e"],        // package.json 의 이 스크립트들을 `&&` 로 쪼개 명령 하나씩으로
//     "wrap": { "test": "xvfb-run -a" },              // (선택) 스위트별로 명령 앞에 붙일 것 — 이미 들어 있으면 붙이지 않는다
//     "commands": { "lint": "npm run lint" },          // (선택) 직접 적은 명령. id → 명령
//     "idPattern": "(scripts/[\\w./-]+\\.(?:js|py))",  // (선택) 쪼갠 명령에서 id 를 뽑는 정규식(첫 묶음). 없으면 명령 문자열이 id
//     "defaultSeconds": 30,
//     "groups": [ { "<id>": 315, "<id>": 10 }, { … } ] // 묶음 배정 + 예상 초(실측으로 채운다)
//   }
//
// 지키는 것
//   · **검사 내용은 바꾸지 않는다** — 명령 문자열을 그대로 실행한다. 로컬 `npm test` 도 그대로다.
//   · 설정에 없는 새 명령은 **조용히 빠지지 않고** 가장 가벼운 묶음에 자동으로 들어간다(경고 한 줄).
//   · 설정에는 있는데 사라진 명령도 경고한다.
//   · 실패해도 묶음 안에서 끝까지 돌아 실패 목록을 한 번에 보여 준다(앞이 실패하면 뒤가 안 도는 `&&` 사슬의 대안).
// 묶음 수를 바꾸면 워크플로의 matrix 도 같이 바꾼다.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const cfgPath = path.resolve(opt('--config') || 'ci/shards.json');
const ROOT = process.cwd();
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

function allCommands() {
  const out = [];
  const idRe = cfg.idPattern ? new RegExp(cfg.idPattern) : null;
  if (cfg.fromPackageJson) {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};
    for (const suite of cfg.fromPackageJson) {
      for (const part of String(scripts[suite] || '').split('&&').map((p) => p.trim()).filter(Boolean)) {
        const m = idRe ? part.match(idRe) : null;
        if (idRe && !m) throw new Error(`[run-shards] ${suite} 의 명령에서 id 를 못 뽑았다: ${part}`);
        const id = m ? m[1] : part;
        const w = cfg.wrap && cfg.wrap[suite];
        const cmd = w && !part.startsWith(w.split(' ')[0]) ? `${w} ${part}` : part;
        out.push({ suite, id, cmd });
      }
    }
  }
  for (const [id, cmd] of Object.entries(cfg.commands || {})) out.push({ suite: 'commands', id, cmd });
  return out;
}

function assign(cmds, n) {
  const groups = Array.from({ length: n }, () => ({ items: [], secs: 0 }));
  const known = new Map();
  (cfg.groups || []).forEach((g, gi) => Object.entries(g).forEach(([id, secs]) => known.set(id, { gi, secs })));
  const unknown = [];
  for (const c of cmds) {
    const k = known.get(c.id);
    if (k && k.gi < n) { groups[k.gi].items.push(c); groups[k.gi].secs += k.secs; } else unknown.push(c);
  }
  for (const c of unknown) {
    const g = groups.reduce((a, b) => (b.secs < a.secs ? b : a));
    g.items.push(c); g.secs += cfg.defaultSeconds || 30;
    console.log(`[run-shards] 경고: ${c.id} 가 설정에 없다 — ${groups.indexOf(g) + 1}번 묶음에 자동 배정`);
  }
  for (const id of known.keys()) if (!cmds.some((c) => c.id === id)) console.log(`[run-shards] 경고: 설정의 ${id} 는 명령 목록에 없다(지워도 된다)`);
  return groups;
}

const cmds = allCommands();
const shard = opt('--shard');
let n = (cfg.groups || [1]).length || 1; let pick = null;
if (shard) {
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (!m || +m[1] < 1 || +m[1] > +m[2]) { console.error('[run-shards] --shard 는 「k/n」 형식'); process.exit(2); }
  pick = +m[1] - 1; n = +m[2];
} else if (!argv.includes('--all') && !argv.includes('--list')) {
  console.error('[run-shards] --shard k/n · --all · --list 중 하나를 준다'); process.exit(2);
}
const groups = assign(cmds, n);
if (argv.includes('--list')) {
  groups.forEach((g, i) => console.log(`${i + 1}번 묶음 (예상 ${g.secs}초)\n${g.items.map((c) => `  · ${c.id}`).join('\n')}`));
  process.exit(0);
}

const runList = pick == null ? groups.flatMap((g) => g.items) : groups[pick].items;
console.log(`[run-shards] ${pick == null ? '전체' : `${pick + 1}/${n} 묶음`} — 명령 ${runList.length}개`);
const results = [];
for (const c of runList) {
  console.log(`\n[run-shards] ▶ ${c.cmd}`);
  const t0 = Date.now();
  const r = spawnSync(c.cmd, { cwd: ROOT, shell: true, stdio: 'inherit' });
  results.push({ ...c, secs: Math.round((Date.now() - t0) / 1000), ok: r.status === 0 });
}
const failed = results.filter((r) => !r.ok);
const lines = [
  `### 테스트 ${pick == null ? '전체' : `${pick + 1}/${n} 묶음`} — ${results.length - failed.length}/${results.length} 통과`,
  '', '| 명령 | 초 | 결과 |', '|---|---:|---|',
  ...results.slice().sort((a, b) => b.secs - a.secs).map((r) => `| ${r.id} | ${r.secs} | ${r.ok ? '통과' : '**실패**'} |`),
  '', `합계 ${results.reduce((s, r) => s + r.secs, 0)}초`,
];
console.log('\n' + lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n\n');
if (failed.length) { console.log(`\n[run-shards] 실패: ${failed.map((r) => r.id).join(', ')}`); process.exit(1); }
