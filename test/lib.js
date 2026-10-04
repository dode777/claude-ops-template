// 시험 공용 도구 — 의존성 없음. 임시 디렉터리에 템플릿 저장소·소비자 저장소를 만들어 실제 CLI·셸 스크립트를 돌린다.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI_REL = 'payload/.claude/ops/bin/claude-ops.js';

let failures = 0; let passes = 0;
function ok(cond, name, detail) {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}${detail ? `\n${String(detail).split('\n').map((l) => '      ' + l).join('\n')}` : ''}`); }
}
function done(file) {
  console.log(`\n${path.basename(file)}: ${passes} 통과 · ${failures} 실패`);
  process.exitCode = failures ? 1 : 0;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: { ...process.env, ...(opts.env || {}) } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '' };
}
function git(cwd, ...args) {
  const r = run('git', args, { cwd, env: GIT_ENV });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 실패 (${cwd}):\n${r.out}`);
  return r.stdout.trim();
}
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir(),
};

function tmpdir(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `ops-test-${label}-`)); }

function copyTree(src, dst, skip = new Set(['.git', 'node_modules'])) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d, skip);
    else { fs.copyFileSync(s, d); fs.chmodSync(d, fs.statSync(s).mode); }
  }
}

// 지금 작업 트리(커밋 전 포함)를 복사해 임시 템플릿 저장소를 만든다.
function makeTemplate() {
  const dir = tmpdir('tpl');
  copyTree(REPO, dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'template');
  return dir;
}
function commitAll(dir, msg) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); }

// 빈 소비자 저장소(+ 원격 역할의 bare 저장소)
function makeConsumer() {
  const dir = tmpdir('svc');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("service");\n');
  commitAll(dir, 'service');
  const bare = tmpdir('origin');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}

function ops(root, ...args) {
  return run(process.execPath, [path.join(REPO, CLI_REL), ...args, '--root', root]);
}
function opsLocal(root, ...args) {   // 소비자에 들어간 판으로
  return run(process.execPath, [path.join(root, '.claude/ops/bin/claude-ops.js'), ...args, '--root', root]);
}

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

module.exports = { REPO, ok, done, run, git, GIT_ENV, tmpdir, copyTree, makeTemplate, makeConsumer, commitAll, ops, opsLocal, read, write };
