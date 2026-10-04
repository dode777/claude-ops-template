// claude-ops sync · check · settings · init · status 를 임시 저장소에서 실제로 돌린다.
//   node test/claude-ops.test.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const { ok, ops, opsLocal, read, write, git } = L;

const tpl = L.makeTemplate();
const lockOf = (root) => JSON.parse(read(path.join(root, '.claude/ops.lock')));

console.log('init — 오버레이 빈 틀 + 첫 sync');
{
  const svc = L.makeConsumer();
  const r = ops(svc, 'init', '--source', tpl, '--source-url', 'https://example.invalid/claude-ops-template.git');
  ok(r.code === 0, 'init 이 성공한다', r.out);
  for (const f of ['.claude/project.env', '.claude/settings.overlay.json', 'CLAUDE.md', '.claude/orchestrator.local.md',
    '.github/workflows/claude-ops-check.yml', '.github/workflows/claude-ops-sync.yml',
    '.claude/ops/bin/preflight.sh', '.claude/agents/ops-implementer.md', '.claude/skills/ops-orchestrator/SKILL.md', '.claude/settings.json']) {
    ok(fs.existsSync(path.join(svc, f)), `${f} 가 생긴다`);
  }
  const lock = lockOf(svc);
  ok(lock.source.url === 'https://example.invalid/claude-ops-template.git', 'lock 에 원격 주소(--source-url)가 남는다');
  ok(/^[0-9a-f]{40}$/.test(lock.source.commit), 'lock 에 템플릿 커밋이 남는다');
  ok(lock.source.version === read(path.join(L.REPO, 'VERSION')).trim(), 'lock 의 버전 = 템플릿 VERSION');
  ok(fs.statSync(path.join(svc, '.claude/ops/bin/preflight.sh')).mode & 0o100, '실행 비트가 보존된다');
  ok(opsLocal(svc, 'check').code === 0, '소비자에 들어간 claude-ops 로 check 통과');

  // 오버레이는 다시 init 해도 덮지 않는다
  write(path.join(svc, 'CLAUDE.md'), '# 서비스 지식\n');
  const r2 = ops(svc, 'init', '--source', tpl);
  ok(r2.code === 0 && read(path.join(svc, 'CLAUDE.md')) === '# 서비스 지식\n', '두 번째 init 은 CLAUDE.md 를 덮지 않는다', r2.out);
}

console.log('\ncheck — 관리 파일을 소비자에서 고치면 실패');
{
  const svc = L.makeConsumer();
  ops(svc, 'init', '--source', tpl);
  L.commitAll(svc, 'adopt');
  const f = path.join(svc, '.claude/ops/docs/CONVENTIONS.md');
  const orig = read(f);
  write(f, orig + '\n소비자가 덧붙인 줄\n');
  let r = opsLocal(svc, 'check');
  ok(r.code === 1 && /CONVENTIONS\.md — 소비자에서 직접 고쳤다/.test(r.out), '관리 파일 변경 → check 실패(1)', r.out);

  // 탈출구: overrides(사유 필수)
  const lock = lockOf(svc);
  lock.overrides = [{ path: '.claude/ops/docs/CONVENTIONS.md', reason: '' }];
  write(path.join(svc, '.claude/ops.lock'), JSON.stringify(lock, null, 2));
  r = opsLocal(svc, 'check');
  ok(r.code === 1 && /reason 이 비었다/.test(r.out), '사유 없는 override 는 받지 않는다', r.out);
  lock.overrides = [{ path: '.claude/ops/docs/CONVENTIONS.md', reason: '급한 오탈자 — 템플릿 PR 대기' }];
  write(path.join(svc, '.claude/ops.lock'), JSON.stringify(lock, null, 2));
  r = opsLocal(svc, 'check');
  ok(r.code === 0 && /고친 판을 쓰는 중: 급한 오탈자/.test(r.out), '사유 있는 override 는 통과하되 경고한다', r.out);
  lock.overrides = [{ path: '.claude/project.env', reason: 'x' }];
  write(path.join(svc, '.claude/ops.lock'), JSON.stringify(lock, null, 2));
  r = opsLocal(svc, 'check');
  ok(r.code === 1 && /관리 파일이 아니다/.test(r.out), '관리 파일이 아닌 경로의 override 는 실패', r.out);
  lock.overrides = [];
  write(path.join(svc, '.claude/ops.lock'), JSON.stringify(lock, null, 2));
  write(f, orig);

  // 관리 구역에 lock 에 없는 파일
  write(path.join(svc, '.claude/agents/ops-extra.md'), '---\nname: x\n---\n');
  r = opsLocal(svc, 'check');
  ok(r.code === 1 && /ops-extra\.md — 관리 구역/.test(r.out), '관리 구역에 lock 에 없는 파일 → 실패', r.out);
  fs.rmSync(path.join(svc, '.claude/agents/ops-extra.md'));
  // 관리 구역 밖(서비스 전용 에이전트)은 자유
  write(path.join(svc, '.claude/agents/service-helper.md'), '---\nname: service-helper\n---\n');
  ok(opsLocal(svc, 'check').code === 0, '관리 구역 밖의 서비스 전용 에이전트는 막지 않는다');

  // 관리 파일 삭제
  fs.rmSync(path.join(svc, '.claude/ops/bin/run-quiet.sh'));
  r = opsLocal(svc, 'check');
  ok(r.code === 1 && /run-quiet\.sh — 없다/.test(r.out), '관리 파일 삭제 → 실패', r.out);
  git(svc, 'checkout', '--', '.claude/ops/bin/run-quiet.sh');

  // lock 없음 → 2
  const bare = L.makeConsumer();
  ok(ops(bare, 'check').code === 2, 'lock 이 없으면 종료 코드 2');
}

console.log('\nsettings — 생성물(base + overlay)');
{
  const svc = L.makeConsumer();
  write(path.join(svc, '.claude/settings.overlay.json'), JSON.stringify({
    _설명: '설명 키는 결과에 들어가지 않는다',
    permissions: { deny: ['Read(./big.json)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo svc' }] }] },
  }));
  ops(svc, 'init', '--source', tpl);
  const s = JSON.parse(read(path.join(svc, '.claude/settings.json')));
  ok(!('_설명' in s), '`_` 키는 결과에서 빠진다');
  ok(JSON.stringify(s.permissions.deny) === '["Read(./big.json)"]', 'overlay 의 deny 가 들어간다');
  ok(s.hooks.SessionStart.length === 2 && /usage-guard/.test(s.hooks.SessionStart[0].hooks[0].command), '훅 배열은 base 다음에 overlay 를 잇는다');
  ok(s.hooks.SubagentStop.length === 1, 'base 의 SubagentStop 훅이 그대로');
  ok(s.$schema && Object.keys(s)[0] === '$schema', '$schema 가 맨 앞');

  // settings.json 직접 수정 → 실패
  write(path.join(svc, '.claude/settings.json'), read(path.join(svc, '.claude/settings.json')).replace('big.json', 'other.json'));
  let r = opsLocal(svc, 'check');
  ok(r.code === 1 && /settings\.json — base \+ overlay 병합 결과와 다르다/.test(r.out), 'settings.json 직접 수정 → 실패', r.out);
  // overlay 를 고치고 settings 재생성 → 통과
  write(path.join(svc, '.claude/settings.overlay.json'), JSON.stringify({ permissions: { deny: ['Read(./other.json)'] } }));
  r = opsLocal(svc, 'check');
  ok(r.code === 1, 'overlay 만 고치고 재생성 안 하면 실패');
  r = opsLocal(svc, 'settings');
  ok(r.code === 0 && opsLocal(svc, 'check').code === 0, 'claude-ops settings 로 재생성하면 통과(오프라인)', r.out);
}

console.log('\nsync — 첫 도입의 기존 settings.json 보호');
{
  const svc = L.makeConsumer();
  write(path.join(svc, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Read(./keep.json)'] } }, null, 2));
  let r = ops(svc, 'sync', '--source', tpl);
  ok(r.code === 1 && /이미 있고 base \+ overlay 병합 결과와 다르다/.test(r.out), '기존 settings.json 과 결과가 다르면 거절', r.out);
  ok(!fs.existsSync(path.join(svc, '.claude/ops.lock')), '거절하면 아무것도 쓰지 않는다(lock 없음)');
  ok(!fs.existsSync(path.join(svc, '.claude/ops/bin/preflight.sh')), '거절하면 관리 파일도 쓰지 않는다');
  write(path.join(svc, '.claude/settings.overlay.json'), JSON.stringify({ permissions: { deny: ['Read(./keep.json)'] } }));
  // 기존 파일에 훅이 없으면 여전히 다르다 → 훅까지 같게 만든 뒤
  const base = JSON.parse(read(path.join(L.REPO, 'payload/.claude/ops/settings.base.json')));
  delete base._설명;
  write(path.join(svc, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Read(./keep.json)'] }, ...base }, null, 2));
  r = ops(svc, 'sync', '--source', tpl);
  ok(r.code === 0, '의미상 같으면(키 순서 무관) 받아들인다', r.out);
}

console.log('\nsync — 오버레이는 덮지 않고, 소비자 수정은 덮기 전에 멈춘다');
{
  const svc = L.makeConsumer();
  ops(svc, 'init', '--source', tpl);
  write(path.join(svc, '.claude/project.env'), 'DEFAULT_BRANCH=main\n# 서비스 값\n');
  const envBefore = read(path.join(svc, '.claude/project.env'));
  // 템플릿 새 버전: 파일 하나 고치고 하나 지우고 하나 더함
  const t2 = L.makeTemplate();
  write(path.join(t2, 'payload/.claude/ops/docs/CONVENTIONS.md'), read(path.join(t2, 'payload/.claude/ops/docs/CONVENTIONS.md')) + '\n새 요구\n');
  fs.rmSync(path.join(t2, 'payload/.claude/agents/ops-explorer.md'));
  write(path.join(t2, 'payload/.claude/ops/docs/NEW.md'), '# 새 문서\n');
  write(path.join(t2, 'VERSION'), '1.1.0\n');
  const c2 = L.commitAll(t2, 'v1.1.0');
  git(t2, 'tag', 'v1.1.0');

  let r = ops(svc, 'sync', '--source', t2, '--ref', 'v1.1.0');
  ok(r.code === 0, '새 버전 sync 성공', r.out);
  ok(read(path.join(svc, '.claude/project.env')) === envBefore, 'project.env(오버레이)는 그대로');
  ok(/새 요구/.test(read(path.join(svc, '.claude/ops/docs/CONVENTIONS.md'))), '고친 관리 파일이 반영된다');
  ok(!fs.existsSync(path.join(svc, '.claude/agents/ops-explorer.md')), '템플릿에서 사라진 관리 파일은 지운다');
  ok(fs.existsSync(path.join(svc, '.claude/ops/docs/NEW.md')), '새 관리 파일이 들어온다');
  const lock = lockOf(svc);
  ok(lock.source.commit === c2 && lock.source.version === '1.1.0' && lock.source.ref === 'v1.1.0', 'lock 이 새 커밋·버전·ref 를 가리킨다');
  ok(opsLocal(svc, 'check').code === 0, 'sync 뒤 check 통과');

  // 소비자에서 고친 뒤 sync → 멈춤(덮지 않음)
  const f = path.join(svc, '.claude/ops/docs/NEW.md');
  write(f, '# 소비자가 고침\n');
  r = ops(svc, 'sync', '--source', t2, '--ref', 'v1.1.0');
  ok(r.code === 1 && /소비자에서 직접 고쳤다/.test(r.out) && read(f) === '# 소비자가 고침\n', '소비자 수정이 있으면 sync 가 멈추고 덮지 않는다', r.out);
  r = ops(svc, 'sync', '--source', t2, '--ref', 'v1.1.0', '--force');
  ok(r.code === 0 && read(f) === '# 새 문서\n', '--force 면 템플릿 판으로 되돌린다', r.out);

  // --ref latest 는 가장 높은 vX.Y.Z (문자열 순서가 아니라 숫자 순서)
  write(path.join(t2, 'VERSION'), '1.10.0\n'); L.commitAll(t2, 'v1.10.0'); git(t2, 'tag', 'v1.10.0');
  write(path.join(t2, 'VERSION'), '1.9.0\n'); L.commitAll(t2, 'v1.9.0'); git(t2, 'tag', 'v1.9.0');
  r = ops(svc, 'sync', '--source', t2, '--ref', 'latest');
  ok(r.code === 0 && lockOf(svc).source.ref === 'v1.10.0', '--ref latest → v1.10.0 (v1.9.0 보다 높다)', r.out);
}

console.log('\nsync — 템플릿이 금지 경로를 가리키면 거절');
{
  const svc = L.makeConsumer();
  ops(svc, 'init', '--source', tpl);
  write(path.join(svc, 'CLAUDE.md'), '# 지식\n');
  for (const evil of ['payload/CLAUDE.md', 'payload/.claude/project.env', 'payload/.github/workflows/x.yml', 'payload/src/app.js']) {
    const t3 = L.makeTemplate();
    write(path.join(t3, evil), 'evil\n');
    L.commitAll(t3, 'evil');
    const r = ops(svc, 'sync', '--source', t3);
    ok(r.code === 1 && /허용되지 않는 경로/.test(r.out), `${evil.replace('payload/', '')} 를 덮으려는 템플릿 → 거절`, r.out);
  }
  ok(read(path.join(svc, 'CLAUDE.md')) === '# 지식\n', '거절 뒤에도 CLAUDE.md 그대로');
}

console.log('\ncheck --deep — lock 을 손으로 고친 것을 템플릿 원본과 대조해 잡는다');
{
  const svc = L.makeConsumer();
  ops(svc, 'init', '--source', tpl, '--source-url', tpl);
  ok(opsLocal(svc, 'check', '--deep').code === 0, '그대로면 --deep 통과');
  const f = path.join(svc, '.claude/ops/docs/CONVENTIONS.md');
  write(f, read(f) + '\n몰래\n');
  const lock = lockOf(svc);
  lock.files['.claude/ops/docs/CONVENTIONS.md'].sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  write(path.join(svc, '.claude/ops.lock'), JSON.stringify(lock, null, 2));
  ok(opsLocal(svc, 'check').code === 0, '(얕은 check 는 lock 만 보므로 못 잡는다 — 받아들인 한계)');
  const r = opsLocal(svc, 'check', '--deep');
  ok(r.code === 1 && /lock 의 지문이 템플릿과 다르다/.test(r.out), '--deep 은 잡는다', r.out);
}

console.log('\nstatus');
{
  const svc = L.makeConsumer();
  ops(svc, 'init', '--source', tpl, '--source-url', tpl);
  const r = opsLocal(svc, 'status');
  ok(r.code === 0 && /관리 파일 \d+개/.test(r.out), 'status 가 요약과 check 결과를 낸다', r.out);
}

L.done(__filename);
