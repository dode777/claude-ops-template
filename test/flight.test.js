// preflight · postflight · run-quiet 를 임시 소비자 저장소에서 실제로 돌린다 — 판정 로직을 일부러 깨진 입력으로 확인한다
// (오케스트레이터 규약 4: 게이트는 자기 자신을 입력으로 넣어 깨 보지 않으면 결함을 못 찾는다).
//   node test/flight.test.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const { ok, ops, read, write, git, run } = L;

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const PAY = path.join(L.REPO, 'payload/.claude/ops/bin');

console.log('셸 문법 (bash -n)');
for (const f of fs.readdirSync(PAY).filter((x) => x.endsWith('.sh'))) {
  const r = run('bash', ['-n', path.join(PAY, f)]);
  ok(r.code === 0, `bash -n ${f}`, r.out);
}
for (const f of ['ci/fingerprint.sh']) {
  if (fs.existsSync(path.join(L.REPO, f))) { const r = run('bash', ['-n', path.join(L.REPO, f)]); ok(r.code === 0, `bash -n ${f}`, r.out); }
}

console.log('\n두 스크립트의 공동 작성자 기본 정규식이 같다');
{
  const re = (f) => (read(path.join(PAY, f)).match(/COAUTHOR_RE="\$\{COMMIT_TRAILER_COAUTHOR_RE:-([^}]*)\}"/) || [])[1];
  const a = re('preflight.sh'); const b = re('postflight.sh');
  ok(a && a === b, 'preflight == postflight', `${a}\n${b}`);
}

console.log('\nrun-quiet — 종료 코드 보존 · 전체 로그 · 고유 경로');
{
  const logDir = L.tmpdir('logs');
  const env = { CLAUDE_OPS_LOG_DIR: logDir };
  const script = 'for i in $(seq 1 300); do echo "줄 $i"; done; echo "FAIL: 무언가 깨짐"; echo "1/2 통과"; exit 3';
  let r = run('bash', [path.join(PAY, 'run-quiet.sh'), '--label', 'agent-a', '--', 'bash', '-c', script], { env });
  ok(r.code === 3, '명령의 종료 코드(3)를 그대로 돌려준다', r.out);
  ok(/FAIL: 무언가 깨짐/.test(r.out) && /1\/2 통과/.test(r.out), '실패 블록과 끝 요약을 보여 준다', r.out);
  ok(!/줄 100\n/.test(r.out), '중간 출력은 화면에 쏟지 않는다');
  const logPath = (r.out.match(/전체 로그 (\S+)/) || [])[1];
  ok(logPath && read(logPath).split('\n').length >= 302, '전체 출력은 로그 파일에 그대로', logPath);
  ok(path.basename(logPath).startsWith('agent-a.'), '로그 이름에 라벨이 들어간다');
  const r2 = run('bash', [path.join(PAY, 'run-quiet.sh'), '--label', 'agent-a', '--', 'true'], { env });
  const log2 = (r2.out.match(/전체 로그 (\S+)/) || [])[1];
  ok(r2.code === 0 && log2 && log2 !== logPath, '같은 라벨로 다시 돌려도 다른 로그 파일', `${logPath}\n${log2}`);
  r = run('bash', [path.join(PAY, 'run-quiet.sh'), '--log', logPath, '--', 'true']);
  ok(r.code === 2 && /덮지 않는다/.test(r.out) && read(logPath).includes('FAIL: 무언가 깨짐'), '--log 로 남의 로그 파일을 덮지 않는다', r.out);
  r = run('bash', [path.join(PAY, 'run-quiet.sh'), '--', 'bash', '-c', 'echo ok'], { env });
  ok(r.code === 0 && !/실패 \(종료 코드/.test(r.out), '성공한 명령은 0', r.out);
}

// ── 소비자 저장소 준비 ─────────────────────────────────────────────────
const tpl = L.makeTemplate();
const svc = L.makeConsumer();
ops(svc, 'init', '--source', tpl);
write(path.join(svc, '.claude/project.env'), [
  'DEFAULT_BRANCH=main',
  `COMMIT_TRAILER_COAUTHOR="${TRAILER}"`,
  'VERIFY_CMD="true"',
  'REPORT_DIR=".claude/reports"',
  'PROTECTED_PATHS="data"',
  'ENV_NOTES=""',
  '',
].join('\n'));
write(path.join(svc, 'data/keep.txt'), '보호\n');
L.commitAll(svc, 'claude-ops 도입');
git(svc, 'push', '-q', 'origin', 'main');
git(svc, 'checkout', '-q', '-b', 'feat/x');

const pre = (env = {}) => run('bash', [path.join(svc, '.claude/ops/bin/preflight.sh')], { env });
const post = (env = {}) => run('bash', [path.join(svc, '.claude/ops/bin/postflight.sh')], { env });

console.log('\npreflight');
{
  let r = pre({ CLAUDE_COAUTHOR: TRAILER, CLAUDE_SESSION_URL: 'https://example.invalid/s/1' });
  ok(r.code === 0 && r.out.includes(`    ${TRAILER}`) && /claude-ops  관리 파일 \d+개 lock 과 일치/.test(r.out), '깨끗한 브랜치에서 통과 · 트레일러 출력 · 관리 파일 대조', r.out);
  r = pre({ CLAUDE_COAUTHOR: 'Co-Authored-By: Claude Banana <noreply@anthropic.com>' });
  ok(r.code === 1 && /모양이 아닙니다/.test(r.out), '지어낸 모델 이름은 시작하지 않는다', r.out);
  r = pre({ CLAUDE_COAUTHOR: TRAILER, COMMIT_TRAILER_COAUTHOR_RE: '.' });
  ok(r.code === 0 && !/재정의했습니다/.test(r.out), '환경변수로 넘긴 정규식은 버린다');
  git(svc, 'checkout', '-q', 'main');
  r = pre();
  ok(r.code === 1 && /지금 main 에 있습니다/.test(r.out), '기본 브랜치 위에서는 시작하지 않는다', r.out);
  git(svc, 'checkout', '-q', 'feat/x');
}

// 보고서 만들기
const tmplReport = read(path.join(svc, '.claude/ops/templates/report.md'));
function filled({ summary = ['- 결론 한 줄', '- 남은 위험 없음'], drop = null } = {}) {
  let s = tmplReport.replace(/## 요약\n\n<!--[\s\S]*?-->\n/, `## 요약\n\n${summary.join('\n')}\n`);
  for (const n of [1, 2, 3, 4, 5, 6]) {
    s = s.replace(new RegExp(`(### ${n}\\. [^\\n]+\\n\\n<!--[\\s\\S]*?-->\\n)`), n === drop ? '$1' : '$1\n해당 없음\n');
  }
  return s;
}
const REPORT = path.join(svc, '.claude/reports/feat-x.md');
const BASE_SHA = git(svc, 'rev-parse', 'HEAD');
function attempt(name, { report, trailer = TRAILER, extra = null, env = {}, expectFail, match }) {
  git(svc, 'reset', '-q', '--hard', BASE_SHA);
  git(svc, 'clean', '-qfd');
  write(path.join(svc, 'app.js'), `console.log(${JSON.stringify(name)});\n`);
  if (report !== undefined) write(REPORT, report);
  if (extra) extra();
  git(svc, 'add', '-A');
  git(svc, 'commit', '-q', '-m', `작업: ${name}${trailer ? `\n\n${trailer}` : ''}`);
  const r = post(env);
  const good = expectFail ? r.code === 1 && (!match || match.test(r.out)) : r.code === 0;
  ok(good, name, r.out);
}

console.log('\npostflight — 통과해야 하는 것');
attempt('채운 보고서 + 트레일러 → 통과', { report: filled() });
attempt('본문에 들여쓴 주석 문법을 언급해도 섹션이 잘리지 않는다', {
  report: filled().replace('### 6. 미확인 목록', '### 6. 미확인 목록\n\n  설명: `<!--` 로 여는 주석은 1열만 주석으로 본다'),
});
attempt('요약 20줄 정확히 → 통과', { report: filled({ summary: Array.from({ length: 20 }, (_, i) => `- ${i + 1}`) }) });

console.log('\npostflight — 막아야 하는 것');
attempt('템플릿을 안내문만 있는 채로 제출 → 실패', { report: tmplReport, expectFail: true, match: /요약` 이 비어 있습니다[\s\S]*L2 항목이 비어/ });
attempt('요약 21줄 → 실패', { report: filled({ summary: Array.from({ length: 21 }, (_, i) => `- ${i + 1}`) }), expectFail: true, match: /21줄입니다/ });
attempt('요약이 맨 앞이 아니다 → 실패', {
  report: filled().replace('## 요약', '## 무엇을 먼저\n\n앞에 끼운 절\n\n## 요약'), expectFail: true, match: /첫 `## ` 제목이 `## 요약` 이 아닙니다/,
});
for (const n of [1, 4, 6]) {
  attempt(`L2 ${n}번을 비움 → 실패`, { report: filled({ drop: n }), expectFail: true, match: new RegExp(`- ${n}\\. `) });
}
attempt('보고서 없음 → 실패', { report: undefined, expectFail: true, match: /보고서가 없습니다/ });
attempt('트레일러 없는 커밋 → 실패', { report: filled(), trailer: null, expectFail: true, match: /공동 작성자 트레일러가 없거나/ });
attempt('줄 앞 공백이 있는 트레일러 → 실패', { report: filled(), trailer: `    ${TRAILER}`, expectFail: true, match: /트레일러가 없거나/ });
attempt('보호 경로 수정 → 실패', {
  report: filled(), extra: () => write(path.join(svc, 'data/keep.txt'), '고침\n'), expectFail: true, match: /보호 경로의 기존 파일/,
});
attempt('보호 경로 면제 — 보고서에 경로가 있으면 통과', {
  report: filled().replace('### 4. 막히면 안 되는 것', '### 4. 막히면 안 되는 것\n\ndata 를 고친 이유: 시험'),
  extra: () => write(path.join(svc, 'data/keep.txt'), '고침\n'), env: { ACCEPT_PROTECTED: 'data' },
});
attempt('관리 파일을 고쳐 커밋 → 실패(claude-ops)', {
  report: filled(), extra: () => write(path.join(svc, '.claude/ops/docs/CONVENTIONS.md'), '바꿔치기\n'),
  expectFail: true, match: /관리 파일이 \.claude\/ops\.lock 과 다릅니다/,
});
attempt('settings.json 을 직접 고쳐 커밋 → 실패(생성물)', {
  report: filled(), extra: () => write(path.join(svc, '.claude/settings.json'), '{}\n'),
  expectFail: true, match: /settings\.json — base \+ overlay/,
});
attempt('요약 상한을 환경변수로 늘려도 무시 → 실패', {
  report: filled({ summary: Array.from({ length: 25 }, (_, i) => `- ${i + 1}`) }), env: { REPORT_SUMMARY_MAX_LINES: '99' },
  expectFail: true, match: /25줄입니다/,
});
attempt('BASE_REF 를 주면 멈춘다', { report: filled(), env: { BASE_REF: 'HEAD~1' }, expectFail: true, match: /BASE_REF 는 없어졌습니다/ });

L.done(__filename);
