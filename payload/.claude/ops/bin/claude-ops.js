#!/usr/bin/env node
// claude-ops — 템플릿(정본)의 관리 파일을 소비자 저장소에 넣고, 그대로인지 검사한다.
//
// 의존성 없음(Node 18+ 내장 모듈만). 소비자에는 이 파일이 `.claude/ops/bin/claude-ops.js` 로 함께 들어간다.
//
//   node .claude/ops/bin/claude-ops.js sync     [--source <경로|URL>] [--ref <브랜치|태그|커밋|latest>]
//                                               [--source-url <URL>] [--force] [--adopt-settings]
//   node .claude/ops/bin/claude-ops.js check    [--deep]          관리 파일이 lock 과 같은지 (postflight · CI)
//   node .claude/ops/bin/claude-ops.js settings                   settings.json 을 base + overlay 로 다시 만든다(오프라인)
//   node .claude/ops/bin/claude-ops.js init     --source <경로|URL> [--ref ...] [--source-url ...]
//   node .claude/ops/bin/claude-ops.js status   [--remote]
//   공통: --root <소비자 저장소 루트>  (없으면 현재 디렉터리의 git 최상위)
//
// ── 왜 이 모양인가 ─────────────────────────────────────────────────────────
// 규약 파일을 여러 저장소에 「복사」 하면 각자 고치기 시작하고, 표류는 diff 잡음에 숨는다(실제로 숨었다).
// 그래서 정본은 템플릿 한 곳이고 소비자는 **버전을 고정해 받기만** 한다(Dependabot/Renovate 와 같은 모양):
//   · sync  — 템플릿을 git 으로 받아 payload/ 를 그대로 쓰고 `.claude/ops.lock` 에 출처·커밋·파일별 sha256 을 남긴다
//   · check — lock 과 대조한다. 소비자에서 관리 파일을 직접 고치면 **실패**한다 → 고치는 곳은 템플릿 한 곳
//   · 오버레이(CLAUDE.md · project.env · settings.overlay.json …)는 소비자 것이다. sync 는 절대 덮지 않는다
//     — 그 보장은 템플릿의 manifest 가 아니라 **이 파일 안의 고정 목록**(RESERVED · MANAGED)으로 한다.
//       sync 를 돌리는 것은 소비자가 이미 가진 이 파일이므로, 받아 온 템플릿이 목록을 넓힐 수 없다.
//
// 플러그인·npm 의존성으로 배포하지 않는 이유: 클라우드 세션은 저장소의 enabledPlugins·마켓플레이스를
// 설치하지 않는다. 저장소에 **커밋된** CLAUDE.md · .claude/{agents,skills,rules} · 훅만 로드된다.
// 그래서 파일은 소비자 저장소에 실제로 커밋되어야 하고, 중앙관리는 lock 과 동기화 PR 로 한다(docs/DESIGN.md).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const LOCK_REL = '.claude/ops.lock';
// 템플릿이 쓸 수 있는 구역(접두사). payload 의 모든 파일은 이 중 하나로 시작해야 한다.
const MANAGED = ['.claude/ops/', '.claude/agents/ops-', '.claude/skills/ops-'];
// 소비자 소유(오버레이·생성물·기록). payload 가 이 경로를 가리키면 sync 가 거절한다.
const RESERVED = [
  'CLAUDE.md', '.claude/CLAUDE.md', '.claude/project.env', '.claude/settings.overlay.json', '.claude/settings.json',
  '.claude/settings.local.json', '.claude/orchestrator.local.md', '.claude/ops.lock',
  '.claude/rules/', '.claude/reports/', '.github/',
];
const SETTINGS = {
  base: '.claude/ops/settings.base.json',
  overlay: '.claude/settings.overlay.json',
  output: '.claude/settings.json',
};

// ── 작은 도구 ──────────────────────────────────────────────────────────────
const C = process.stdout.isTTY ? { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', x: '\x1b[0m' } : { r: '', y: '', g: '', x: '' };
const out = (s = '') => process.stdout.write(s + '\n');
const warn = (s) => out(`${C.y}  경고  ${s}${C.x}`);
class Fail extends Error {}
const die = (msg) => { throw new Fail(msg); };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  if (r.error) die(`git 을 실행하지 못했다: ${r.error.message}`);
  return r;
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[key] = true; else { a[key] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

function findRoot(arg) {
  if (arg && arg !== true) return path.resolve(arg);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return process.cwd();
}

function readJson(file, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    die(`${what} 를 읽지 못했다(${file}): ${e.message}`);
  }
}

function walk(dir, base = dir) {
  const res = [];
  if (!fs.existsSync(dir)) return res;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) res.push(...walk(p, base));
    else if (ent.isFile()) res.push(posix(path.relative(base, p)));
  }
  return res.sort();
}

const isManaged = (rel) => MANAGED.some((m) => rel.startsWith(m));
const isReserved = (rel) => RESERVED.some((r) => (r.endsWith('/') ? rel.startsWith(r) : rel === r));
const modeOf = (file) => ((fs.statSync(file).mode & 0o111) ? '755' : '644');

// ── settings 병합 ──────────────────────────────────────────────────────────
// base(템플릿 공통 — 사용량 훅 등) + overlay(서비스 — deny 목록 등) → settings.json.
//   · 객체는 키별로 재귀 병합, 배열은 이어 붙이고 같은 항목은 한 번만(훅·권한 규칙이 겹치지 않게)
//   · 스칼라는 overlay 가 이긴다
//   · 최상위 `_` 로 시작하는 키는 설명용 — 결과에 넣지 않는다(JSON 에는 주석이 없다)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  if (b === undefined) return a;
  if (isObj(a) && isObj(b)) {
    const o = {};
    for (const k of Object.keys(a)) o[k] = k in b ? deepMerge(a[k], b[k]) : a[k];
    for (const k of Object.keys(b)) if (!(k in a)) o[k] = b[k];
    return o;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(); const o = [];
    for (const v of [...a, ...b]) { const k = JSON.stringify(v); if (!seen.has(k)) { seen.add(k); o.push(v); } }
    return o;
  }
  return b;
}
function stripMeta(o) {
  if (!isObj(o)) return o;
  const r = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) r[k] = v;
  return r;
}
function mergeSettings(base, overlay) {
  return deepMerge(stripMeta(base || {}), stripMeta(overlay || {}));
}
const serialize = (o) => JSON.stringify(o, null, 2) + '\n';
// 키 순서와 무관한 비교용 정규화
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
  return v;
}
const sameJson = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function buildSettings(root) {
  const base = readJson(path.join(root, SETTINGS.base), 'settings.base.json');
  if (base === undefined) return null;          // 템플릿이 settings 를 주지 않으면 생성하지 않는다
  const overlay = readJson(path.join(root, SETTINGS.overlay), 'settings.overlay.json');
  return serialize(mergeSettings(base, overlay));
}

// ── lock ───────────────────────────────────────────────────────────────────
function readLock(root) {
  return readJson(path.join(root, LOCK_REL), 'ops.lock');
}
function writeLock(root, lock) {
  const files = {};
  for (const k of Object.keys(lock.files).sort()) files[k] = lock.files[k];
  const o = {
    _설명: '관리 파일의 출처와 지문(claude-ops). 손으로 고치지 말 것 — 고치는 곳은 템플릿이고, 반영은 `claude-ops sync` 다. '
      + '급하게 소비자에서 관리 파일을 고쳐야 하면 overrides 에 {path, reason} 을 적는다(check 가 경고로 계속 알린다).',
    schema: 1,
    source: lock.source,
    files,
    generated: lock.generated || {},
    overrides: lock.overrides || [],
  };
  fs.writeFileSync(path.join(root, LOCK_REL), serialize(o));
}

// ── 템플릿 받기 ─────────────────────────────────────────────────────────────
// 비공개 템플릿이면 CLAUDE_OPS_TOKEN 을 http.extraHeader 로 넘긴다 — URL 에 넣지 않는다(로그·remote 설정에 남는다).
function authArgs(src) {
  const tok = process.env.CLAUDE_OPS_TOKEN;
  if (!tok || !/^https:\/\//.test(src)) return [];
  const b64 = Buffer.from(`x-access-token:${tok}`).toString('base64');
  return ['-c', `http.extraHeader=AUTHORIZATION: basic ${b64}`];
}
const isLocalRepo = (src) => !/^[a-z]+:\/\//i.test(src) && !/^[\w.-]+@[\w.-]+:/.test(src) && fs.existsSync(src);

function semverTags(src) {
  const r = git([...authArgs(src), 'ls-remote', '--tags', '--refs', src]);
  if (r.status !== 0) die(`태그 목록을 읽지 못했다(${src}):\n${r.stderr.trim()}\n${hintAccess()}`);
  const tags = r.stdout.split('\n').map((l) => (l.split('\t')[1] || '').replace('refs/tags/', ''))
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const key = (t) => t.slice(1).split('.').map(Number);
  return tags.sort((x, y) => { const a = key(x), b = key(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
}
function resolveRef(src, ref) {
  if (ref !== 'latest') return ref;
  const tags = semverTags(src);
  if (!tags.length) die(`템플릿에 vX.Y.Z 태그가 없다(${src}) — --ref <브랜치|커밋> 으로 지정하거나 템플릿에 태그를 붙인다.`);
  return tags[tags.length - 1];
}
function hintAccess() {
  return '      템플릿이 공개 저장소면 토큰 없이 받아진다. 비공개면 CLAUDE_OPS_TOKEN(읽기 권한 토큰)을 환경변수로 넘긴다.\n'
    + '      주소가 맞는지(--source · ops.lock 의 source.url)도 확인한다.';
}

function fetchTemplate(src, ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ops-'));
  const dir = path.join(tmp, 'tpl');
  const local = isLocalRepo(src);
  let ok = false;
  if (!local && ref) {   // 브랜치·태그는 얕게 받는다
    ok = git([...authArgs(src), 'clone', '--quiet', '--depth', '1', '--branch', ref, src, dir]).status === 0;
  }
  if (!ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    const r = git([...authArgs(src), 'clone', '--quiet', ...(local ? ['--no-hardlinks'] : []), src, dir]);
    if (r.status !== 0) die(`템플릿을 받지 못했다(${src}):\n${r.stderr.trim()}\n${hintAccess()}`);
    if (ref) {
      const c = git(['-C', dir, 'checkout', '--quiet', ref]);
      if (c.status !== 0) die(`템플릿에서 ${ref} 를 찾지 못했다:\n${c.stderr.trim()}`);
    }
  }
  const commit = git(['-C', dir, 'rev-parse', 'HEAD']).stdout.trim();
  let version = null;
  try { version = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch { /* 없으면 null */ }
  return { dir, tmp, commit, version, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function payloadOf(tplDir) {
  const manifest = readJson(path.join(tplDir, 'manifest.json'), 'manifest.json') || {};
  const pdir = path.join(tplDir, manifest.payloadDir || 'payload');
  if (!fs.existsSync(pdir)) die(`템플릿에 payload 디렉터리가 없다: ${pdir}`);
  const files = walk(pdir);
  const bad = [];
  for (const rel of files) {
    if (rel.split('/').includes('..')) bad.push(`${rel} (상대 경로 탈출)`);
    else if (isReserved(rel)) bad.push(`${rel} (소비자 소유 경로 — 템플릿이 덮을 수 없다)`);
    else if (!isManaged(rel)) bad.push(`${rel} (관리 구역 밖 — 허용: ${MANAGED.join(' ')})`);
  }
  if (bad.length) die(`템플릿의 payload 가 허용되지 않는 경로를 가리킨다 — sync 하지 않는다:\n${bad.map((b) => '      ' + b).join('\n')}`);
  return { pdir, files };
}

// ── sync ───────────────────────────────────────────────────────────────────
function sync(root, a, opts = {}) {
  const old = readLock(root);
  const overrides = (old && old.overrides) || [];
  const overridden = new Set(overrides.map((o) => o.path));
  const src = a.source && a.source !== true ? a.source : old && old.source && old.source.url;
  if (!src) die('템플릿 위치를 모른다 — --source <경로|URL> 를 준다(첫 동기화) 또는 ops.lock 의 source.url 을 확인한다.');
  const wantRef = a.ref && a.ref !== true ? a.ref : (old && old.source && old.source.ref) || null;
  const ref = wantRef ? resolveRef(src, wantRef) : null;

  out(`[claude-ops] sync  ${src}${ref ? ` @ ${ref}` : ''}`);
  const tpl = fetchTemplate(src, ref);
  try {
    const { pdir, files } = payloadOf(tpl.dir);
    const problems = [];
    const oldFiles = (old && old.files) || {};

    // 1) 쓰기 전에 전부 검사한다 — 반쯤 쓰고 멈추지 않게
    for (const [rel, info] of Object.entries(oldFiles)) {
      const p = path.join(root, rel);
      if (!fs.existsSync(p) || overridden.has(rel)) continue;
      if (sha256(fs.readFileSync(p)) !== info.sha256) problems.push(`${rel} — 소비자에서 직접 고쳤다(lock 과 다름)`);
    }
    for (const rel of files) {
      if (rel in oldFiles) continue;
      const p = path.join(root, rel);
      if (fs.existsSync(p) && sha256(fs.readFileSync(p)) !== sha256(fs.readFileSync(path.join(pdir, rel)))) {
        problems.push(`${rel} — 관리 구역에 이미 다른 내용의 파일이 있다`);
      }
    }
    const gen = old && old.generated && old.generated[SETTINGS.output];
    const outPath = path.join(root, SETTINGS.output);
    if (gen && fs.existsSync(outPath) && sha256(fs.readFileSync(outPath)) !== gen.sha256) {
      problems.push(`${SETTINGS.output} — 생성물인데 직접 고쳤다. ${SETTINGS.overlay} 를 고치고 \`claude-ops settings\` 로 다시 만든다`);
    }
    if (problems.length && !a.force) {
      die(`관리 파일이 lock 과 다르다 — 덮어쓰면 그 변경이 사라진다:\n${problems.map((p) => '      ' + p).join('\n')}\n`
        + '      고친 내용이 필요하면 템플릿에 올린다(정본). 버려도 되면 --force. 당장 소비자에서만 유지해야 하면\n'
        + '      ops.lock 의 overrides 에 {"path": …, "reason": …} 를 적는다.');
    }

    // 2) 첫 도입이면 지금 settings.json 과 병합 결과가 의미상 같은지 본다 — 조용히 설정을 잃지 않게
    const newBase = readJson(path.join(pdir, SETTINGS.base), 'settings.base.json');
    let settingsText = null;
    if (newBase !== undefined) {
      const overlay = readJson(path.join(root, SETTINGS.overlay), 'settings.overlay.json');
      settingsText = serialize(mergeSettings(newBase, overlay));
      if (!gen && fs.existsSync(outPath) && !a['adopt-settings']) {
        const cur = readJson(outPath, 'settings.json');
        if (!sameJson(cur, JSON.parse(settingsText))) {
          die(`${SETTINGS.output} 가 이미 있고 base + overlay 병합 결과와 다르다 — 덮으면 설정이 바뀐다.\n`
            + `      서비스 고유 설정을 ${SETTINGS.overlay} 로 옮긴 뒤 다시 돌리거나, 바뀌는 것을 확인했으면 --adopt-settings.\n`
            + `      병합 결과 미리 보기:  node .claude/ops/bin/claude-ops.js settings --print --base <템플릿>/payload/${SETTINGS.base}`);
        }
      }
    }

    // 3) 쓴다
    const lockFiles = {};
    for (const rel of files) {
      const from = path.join(pdir, rel);
      const to = path.join(root, rel);
      const buf = fs.readFileSync(from);
      const mode = modeOf(from);
      lockFiles[rel] = { sha256: sha256(buf), mode };
      if (overridden.has(rel) && fs.existsSync(to)) { warn(`${rel} — overrides 에 있어 소비자 판을 둔다(템플릿 판과 비교해 정본에 반영할 것)`); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, buf);
      fs.chmodSync(to, mode === '755' ? 0o755 : 0o644);
    }
    for (const rel of Object.keys(oldFiles)) {
      if (rel in lockFiles) continue;
      const p = path.join(root, rel);
      if (overridden.has(rel)) { warn(`${rel} — 템플릿에서 사라졌지만 overrides 에 있어 지우지 않는다`); continue; }
      if (fs.existsSync(p)) { fs.rmSync(p); out(`  지움  ${rel} (템플릿에서 사라짐)`); }
      // 빈 디렉터리 정리
      let d = path.dirname(p);
      while (d.startsWith(path.join(root, '.claude')) && d !== path.join(root, '.claude') && fs.existsSync(d) && !fs.readdirSync(d).length) {
        fs.rmdirSync(d); d = path.dirname(d);
      }
    }
    const generated = {};
    if (settingsText !== null) {
      fs.writeFileSync(outPath, settingsText);
      generated[SETTINGS.output] = { sha256: sha256(Buffer.from(settingsText)), from: [SETTINGS.base, SETTINGS.overlay] };
    }

    let url = a['source-url'] && a['source-url'] !== true ? a['source-url'] : null;
    if (!url) url = isLocalRepo(src) ? (old && old.source && old.source.url) || null : src;
    if (!url) warn('ops.lock 에 템플릿 원격 주소가 없다 — 자동 동기화가 템플릿을 찾지 못한다. --source-url <URL> 로 남긴다.');
    const staleOverrides = overrides.filter((o) => !(o.path in lockFiles));
    if (staleOverrides.length) warn(`템플릿에 없는 경로의 overrides: ${staleOverrides.map((o) => o.path).join(', ')} — 지워도 된다`);

    writeLock(root, {
      source: { url, ref: ref || 'HEAD', commit: tpl.commit, version: tpl.version },
      files: lockFiles, generated, overrides,
    });
    out(`  관리 파일 ${files.length}개 · 템플릿 ${tpl.version || '?'} (${tpl.commit.slice(0, 12)}) · lock ${LOCK_REL}`);
    if (!opts.quiet) out(`${C.g}[claude-ops] sync 끝${C.x}`);
  } finally {
    tpl.cleanup();
  }
}

// ── check ──────────────────────────────────────────────────────────────────
function trackedInManaged(root) {
  // git 저장소면 .gitignore 를 따르는 목록(추적 + 무시되지 않은 새 파일), 아니면 파일 시스템
  const r = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '--', '.claude'], { encoding: 'utf8' });
  let list;
  if (r.status === 0) list = r.stdout.split('\n').filter(Boolean);
  else list = walk(path.join(root, '.claude')).map((p) => '.claude/' + p);
  return list.filter((rel) => isManaged(rel) && fs.existsSync(path.join(root, rel)));
}

function check(root, a) {
  const lock = readLock(root);
  if (!lock) { out(`${C.y}[claude-ops] ${LOCK_REL} 이 없다 — 이 저장소는 아직 템플릿을 받지 않았다(claude-ops init).${C.x}`); return 2; }
  const fails = []; const warns = [];
  const overrides = lock.overrides || [];
  const ov = new Map();
  for (const o of overrides) {
    if (!o || !o.path) { fails.push('overrides 항목에 path 가 없다'); continue; }
    if (!o.reason || !String(o.reason).trim()) fails.push(`overrides ${o.path} — reason 이 비었다(사유 없는 탈출구는 받지 않는다)`);
    if (!(o.path in (lock.files || {}))) fails.push(`overrides ${o.path} — 관리 파일이 아니다(lock 에 없음)`);
    ov.set(o.path, o);
  }
  for (const [rel, info] of Object.entries(lock.files || {})) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) { (ov.has(rel) ? warns : fails).push(`${rel} — 없다`); continue; }
    const same = sha256(fs.readFileSync(p)) === info.sha256;
    if (same && ov.has(rel)) warns.push(`${rel} — overrides 에 있지만 템플릿 판과 같다(지워도 된다)`);
    else if (!same && ov.has(rel)) warns.push(`${rel} — 소비자에서 고친 판을 쓰는 중: ${ov.get(rel).reason}`);
    else if (!same) fails.push(`${rel} — 소비자에서 직접 고쳤다(lock 과 다름)`);
  }
  for (const rel of trackedInManaged(root)) {
    if (!(rel in (lock.files || {}))) fails.push(`${rel} — 관리 구역(${MANAGED.join(' ')})에 lock 에 없는 파일`);
  }
  const gen = (lock.generated || {})[SETTINGS.output];
  if (gen) {
    const want = buildSettings(root);
    const outPath = path.join(root, SETTINGS.output);
    const have = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
    if (want === null) fails.push(`${SETTINGS.base} 가 없어 ${SETTINGS.output} 를 확인할 수 없다`);
    else if (have !== want) fails.push(`${SETTINGS.output} — base + overlay 병합 결과와 다르다(생성물). ${SETTINGS.overlay} 를 고치고 \`claude-ops settings\``);
  }
  if (a.deep) {
    const src = lock.source && lock.source.url;
    if (!src) fails.push('--deep: ops.lock 에 source.url 이 없다');
    else {
      const tpl = fetchTemplate(src, lock.source.commit);
      try {
        const { pdir, files } = payloadOf(tpl.dir);
        const want = Object.fromEntries(files.map((rel) => [rel, sha256(fs.readFileSync(path.join(pdir, rel)))]));
        for (const rel of new Set([...Object.keys(want), ...Object.keys(lock.files || {})])) {
          if (!lock.files[rel]) fails.push(`--deep: ${rel} — 템플릿 ${lock.source.commit.slice(0, 12)} 에 있는데 lock 에 없다`);
          else if (!want[rel]) fails.push(`--deep: ${rel} — lock 에 있는데 템플릿 ${lock.source.commit.slice(0, 12)} 에 없다`);
          else if (want[rel] !== lock.files[rel].sha256) fails.push(`--deep: ${rel} — lock 의 지문이 템플릿과 다르다(lock 을 손으로 고쳤다)`);
        }
      } finally { tpl.cleanup(); }
    }
  }
  const s = lock.source || {};
  const label = `템플릿 ${s.version || '?'} (${String(s.commit || '').slice(0, 12)})`;
  for (const w of warns) warn(w);
  if (fails.length) {
    out(`${C.r}  claude-ops  관리 파일이 ${LOCK_REL} 과 다르다 — ${label}:${C.x}`);
    for (const f of fails) out(`      ${f}`);
    out('      관리 파일은 템플릿에서 고친다(정본 한 곳). 반영은 `claude-ops sync --ref <버전>`.');
    out('      급하면 ops.lock 의 overrides 에 {"path": "…", "reason": "…"} — check 가 경고로 계속 알린다.');
    return 1;
  }
  out(`  claude-ops  관리 파일 ${Object.keys(lock.files || {}).length}개 lock 과 일치 ✔  ${label}${a.deep ? ' · 템플릿 원본 대조 ✔' : ''}`);
  return 0;
}

// ── settings (오프라인 재생성) ───────────────────────────────────────────────
function settingsCmd(root, a) {
  let text;
  if (a.base && a.base !== true) {
    const overlay = readJson(path.join(root, SETTINGS.overlay), 'settings.overlay.json');
    text = serialize(mergeSettings(readJson(path.resolve(a.base), 'base'), overlay));
  } else text = buildSettings(root);
  if (text === null) die(`${SETTINGS.base} 가 없다 — 먼저 sync`);
  if (a.print) { process.stdout.write(text); return 0; }
  fs.writeFileSync(path.join(root, SETTINGS.output), text);
  const lock = readLock(root);
  if (lock) {
    lock.generated = lock.generated || {};
    lock.generated[SETTINGS.output] = { sha256: sha256(Buffer.from(text)), from: [SETTINGS.base, SETTINGS.overlay] };
    writeLock(root, lock);
  }
  out(`  ${SETTINGS.output} 를 base + overlay 로 다시 만들었다`);
  return 0;
}

// ── init ───────────────────────────────────────────────────────────────────
// 오버레이 빈 틀을 만들고(있으면 건드리지 않는다) 첫 sync 를 한다.
function init(root, a) {
  const src = a.source && a.source !== true ? a.source : null;
  if (!src) die('init 에는 --source <템플릿 경로|URL> 가 필요하다');
  const ref = a.ref && a.ref !== true ? resolveRef(src, a.ref) : null;
  const tpl = fetchTemplate(src, ref);
  try {
    const manifest = readJson(path.join(tpl.dir, 'manifest.json'), 'manifest.json') || {};
    const map = (manifest.init && manifest.init.files) || {};
    for (const [from, to] of Object.entries(map)) {
      const dst = path.join(root, to);
      if (fs.existsSync(dst)) { out(`  둠    ${to} (이미 있다 — 오버레이는 덮지 않는다)`); continue; }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(tpl.dir, from), dst);
      out(`  만듦  ${to}`);
    }
  } finally { tpl.cleanup(); }
  sync(root, { ...a, ref: ref || a.ref }, { quiet: true });
  out(`${C.g}[claude-ops] init 끝${C.x} — 다음: .claude/project.env 값 채우기 · CLAUDE.md 에 서비스 지식 쓰기 · git add · 커밋 (docs/ADOPT.md)`);
  return 0;
}

// ── status ─────────────────────────────────────────────────────────────────
function status(root, a) {
  const lock = readLock(root);
  if (!lock) { out(`${LOCK_REL} 없음 — 템플릿을 받지 않은 저장소`); return 2; }
  const s = lock.source || {};
  out(`템플릿   ${s.url || '(주소 없음)'}`);
  out(`버전     ${s.version || '?'}  ref ${s.ref || '?'}  커밋 ${s.commit || '?'}`);
  out(`관리 파일 ${Object.keys(lock.files || {}).length}개 · 생성물 ${Object.keys(lock.generated || {}).join(', ') || '없음'} · overrides ${(lock.overrides || []).length}개`);
  if (a.remote && s.url) {
    const tags = semverTags(s.url);
    const latest = tags[tags.length - 1];
    out(`최신 태그 ${latest || '(없음)'}${latest && `v${s.version}` !== latest ? '  ← 갱신 가능: claude-ops sync --ref latest' : ''}`);
  }
  return check(root, {});
}

// ── 진입점 ─────────────────────────────────────────────────────────────────
function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const root = findRoot(a.root);
  switch (cmd) {
    case 'sync': sync(root, a); return 0;
    case 'check': return check(root, a);
    case 'settings': return settingsCmd(root, a);
    case 'init': return init(root, a);
    case 'status': return status(root, a);
    default:
      out('사용법: claude-ops <sync|check|settings|init|status> [--root <경로>] …  (파일 머리말 참고)');
      return cmd ? 2 : 0;
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    if (e instanceof Fail) { process.stderr.write(`${C.r}[claude-ops] ${e.message}${C.x}\n`); process.exitCode = 1; } else throw e;
  }
}

module.exports = { mergeSettings, deepMerge, serialize, sameJson, isManaged, isReserved, MANAGED, RESERVED, main };
