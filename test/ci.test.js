// ci/ 부품(fingerprint.sh · run-shards.js)을 임시 저장소에서 돌린다.
//   node test/ci.test.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const { ok, run, write, git } = L;

console.log('fingerprint.sh — 내용이 키');
{
  const d = L.tmpdir('fp');
  git(d, 'init', '-q', '-b', 'main');
  write(path.join(d, 'src.js'), '1\n'); write(path.join(d, 'docs/a.md'), 'doc\n'); write(path.join(d, 'docs/read.md'), 'read\n');
  L.commitAll(d, 'a');
  const fp = (...a) => run('bash', [path.join(L.REPO, 'ci/fingerprint.sh'), ...a], { cwd: d }).stdout.trim();
  const args = ['--exclude', 'docs', '--include', 'docs/read.md'];
  const h1 = fp(...args);
  ok(/^[0-9a-f]{40}$/.test(h1), '40자 지문');
  write(path.join(d, 'docs/a.md'), 'doc 2\n'); L.commitAll(d, 'b');
  ok(fp(...args) === h1, '뺀 문서만 바뀌면 지문이 같다');
  write(path.join(d, 'docs/read.md'), 'read 2\n'); L.commitAll(d, 'c');
  const h2 = fp(...args);
  ok(h2 !== h1, '되살린(--include) 문서가 바뀌면 지문이 바뀐다');
  git(d, 'commit', '-q', '--allow-empty', '-m', 'empty');
  ok(fp(...args) === h2, '커밋만 늘고 내용이 같으면 지문이 같다');
}

console.log('\nrun-shards.js — 묶음 배정 · 끝까지 실행 · 종료 코드');
{
  const d = L.tmpdir('shards');
  write(path.join(d, 'scripts/a.js'), 'console.log("a")\n');
  write(path.join(d, 'scripts/b.js'), 'process.exit(1)\n');
  write(path.join(d, 'scripts/c.js'), 'console.log("c")\n');
  write(path.join(d, 'scripts/new.js'), 'console.log("new")\n');
  write(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node scripts/a.js && node scripts/b.js && node scripts/c.js && node scripts/new.js' } }));
  write(path.join(d, 'ci/shards.json'), JSON.stringify({
    fromPackageJson: ['test'], idPattern: '(scripts/[\\w./-]+\\.js)', defaultSeconds: 5,
    groups: [{ 'scripts/a.js': 100, 'scripts/b.js': 1 }, { 'scripts/c.js': 10, 'scripts/gone.js': 1 }],
  }));
  const rs = (...a) => run(process.execPath, [path.join(L.REPO, 'ci/run-shards.js'), '--config', 'ci/shards.json', ...a], { cwd: d });
  let r = rs('--list');
  ok(r.code === 0 && /new\.js 가 설정에 없다 — 2번 묶음/.test(r.out), '설정에 없는 새 명령은 가벼운 묶음에 자동 배정', r.out);
  ok(/gone\.js 는 명령 목록에 없다/.test(r.out), '사라진 명령도 경고');
  r = rs('--shard', '1/2');
  ok(r.code === 1 && /1\/2 통과/.test(r.out) && /실패: scripts\/b\.js/.test(r.out), '실패해도 묶음 끝까지 돌고 종료 코드 1', r.out);
  r = rs('--shard', '2/2');
  ok(r.code === 0 && /2\/2 통과/.test(r.out), '다른 묶음은 통과', r.out);
  r = rs();
  ok(r.code === 2, '--shard · --all · --list 없으면 2');
}

L.done(__filename);
