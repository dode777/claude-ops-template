#!/usr/bin/env bash
# .claude/ops/bin/preflight.sh — 작업 시작 전 기계 검사 (L1).
#
# 판단이 필요 없는 것만 본다. 실패하면 작업을 시작하지 않는다.
# 규약 전체는 .claude/ops/docs/CONVENTIONS.md. 프로젝트별 값은 .claude/project.env(오버레이) 한 곳.
#
# **에이전트는 이 파일을 읽지 말고 실행만 한다** — 근거 주석이 길어 읽으면 컨텍스트만 찬다.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # .claude
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1

# 트레일러 모양의 재정의는 **project.env 에서만** 받는다(오케스트레이터 규약 12). 환경변수로 넘어온 값은
# 버린다 — `COMMIT_TRAILER_COAUTHOR_RE=.` 한 줄로 검사가 조용히 꺼지면, 보고서에 사유를 적어야
# 하는 ACCEPT_UNTRAILERED 를 기록 없이 우회하는 것이 된다(적대적 검증 실측). project.env 는
# 커밋되어 리뷰를 거치고, 환경변수는 거치지 않는다.
#
# `unset` 이 아니라 **대입**으로 비운다 — `unset` 은 환경으로 넘어온 셸 함수
# (`BASH_FUNC_unset%%`)가 가로챌 수 있다(검증 실측). 대입문은 함수로 바꿀 수 없다.
# 빈 값은 아래 `${…:-기본값}` 이 미설정과 같이 다룬다.
COMMIT_TRAILER_COAUTHOR_RE=
# git replace 로 커밋 메시지를 바꿔치기하면 로컬 검사만 속는다(그 ref 는 푸시되지 않는다).
# 두 스크립트 모두 치환 객체를 보지 않게 한다.
export GIT_NO_REPLACE_OBJECTS=1

fail() { printf '\n\033[31m[preflight] %s\033[0m\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }

[ -f "$HERE/project.env" ] || fail ".claude/project.env 가 없습니다 — 이 저장소의 값(기본 브랜치·검증 명령 등)을 적는 오버레이입니다.
      새 저장소면:  node .claude/ops/bin/claude-ops.js init --source <템플릿 URL>   (템플릿 docs/ADOPT.md)"
# shellcheck source=/dev/null
. "$HERE/project.env"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
REPORT_DIR="${REPORT_DIR:-.claude/reports}"
VERIFY_CMD="${VERIFY_CMD:-}"

printf '\n[preflight] %s\n\n' "$(basename "$ROOT")"

# ── 1. 기본 브랜치를 최신으로 가져온다 ────────────────────────────────
# 얕은 클론에서 `git fetch origin <브랜치명>` 만 하면 FETCH_HEAD 만 갱신되고
# origin/<브랜치> 원격추적 ref 는 낡은 채로 남는다. 그 상태로 기준점을 확인하면
# "최신 기반" 이라는 잘못된 답을 얻는다. 전체 refspec 을 쓴다.
git fetch origin "+refs/heads/*:refs/remotes/origin/*" --quiet 2>/dev/null \
  || fail "origin fetch 실패 — 네트워크나 원격 설정을 확인하세요."

BASE="origin/$DEFAULT_BRANCH"
git rev-parse --verify --quiet "$BASE" >/dev/null \
  || fail "$BASE 를 찾을 수 없습니다. project.env 의 DEFAULT_BRANCH 를 확인하세요."

# ── 2. 브랜치 기준점 ──────────────────────────────────────────────────
CUR="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CUR" = "$DEFAULT_BRANCH" ]; then
  fail "지금 $DEFAULT_BRANCH 에 있습니다. 작업 브랜치를 만들고 다시 실행하세요:
      git checkout -B <브랜치명> $BASE
      (브랜치 이름은 **새로** 짓습니다 — 다른 worktree 가 체크아웃한 브랜치 이름을 쓰면 그쪽 인덱스가 어긋납니다.)"
fi

if ! git merge-base --is-ancestor "$BASE" HEAD; then
  BEHIND="$(git rev-list --count "HEAD..$BASE")"
  fail "이 브랜치가 최신 $BASE 에서 갈라져 나오지 않았습니다 ($BEHIND 커밋 뒤짐).

      그대로 머지하면 그 $BEHIND 개 커밋의 작업이 되돌아갑니다.
      실제로 낡은 기준점의 브랜치를 머지해 다른 작업 전체가 되돌아갈 뻔한 사고가 있었습니다.

      아직 커밋이 없으면:  git checkout -B $CUR $BASE
      커밋이 있으면:       git rebase $BASE"
fi
note "기준점  $CUR → $BASE ✔"

# ── 3. 작업 트리 ──────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  fail "작업 트리가 깨끗하지 않습니다. 남의 변경 위에 쌓지 않도록 먼저 정리하세요:
$(git status --short | sed 's/^/      /')"
fi
note "작업 트리  깨끗함 ✔"

# ── 3.5. 관리 파일 표류 ───────────────────────────────────────────────
# **경고만 한다.** 시작 시점에 이미 어긋난 것을 알고 작업하는 것이 목적이고, 남이 어긋나게 둔 것으로
# 작업을 막으면 안 된다. 끝낼 때 postflight 가 다시 보고 거기서 실패로 본다.
if [ -f "$HERE/ops.lock" ] && command -v node >/dev/null 2>&1; then
  node "$HERE/ops/bin/claude-ops.js" check --root "$ROOT" 2>&1 || true
fi
# 템플릿 도입 이전의 복사본 지문 검사(conventions-hash.sh)가 남아 있는 저장소는 그것도 경고로 돌린다.
if [ -f "$HERE/bin/conventions-hash.sh" ]; then
  bash "$HERE/bin/conventions-hash.sh" --check 2>&1 || true
fi

# ── 4. 커밋 트레일러 — 판단하지 말고 복사한다 ─────────────────────────
# 공동 작성자 줄은 **그 작업을 실제로 한 모델**을 적는다. 모델은 고정하지 않고 작업마다
# 고르므로(오케스트레이터 규약 12) 한 문자열로 박아 둘 수 없다 — 세션 링크와 같은 방식으로
# 오케스트레이터가 CLAUDE_COAUTHOR 로 넘기고, 안 넘기면 project.env 의 기본값을 쓴다.
#
# **어느 쪽에서 왔든 모양을 검사한다.** 오타 난 줄이 끝에 postflight 에서야 드러나면 커밋을
# 전부 고쳐 써야 한다. 시작 시점에 막는 편이 싸다.
#
# 이 기본 정규식은 postflight 의 것과 **같아야 한다.** 갈리면 두 방향 다 나쁘다 —
# postflight 가 더 좁으면 시작은 통과하고 끝에서 막히고, **더 넓으면 여기서 막을 줄을
# 끝에서 조용히 통과시킨다.** 관리 파일 지문(ops.lock)은 **저장소 사이**의 표류만 잡고,
# 한 저장소 안에서 두 정규식이 같은지는 잡지 않는다 — 고칠 때 둘을 **함께** 고친다
# (템플릿의 test/ 가 두 정규식이 같은지 본다).
#
# 버전은 `5` · `5.5` · `4.5` 꼴만 받는다(앞자리 0·세 마디 거부). 버전을 모르면 **빼고**
# 계열명만 쓴다 — 추측한 버전을 적는 것보다 낫다.
COAUTHOR_RE="${COMMIT_TRAILER_COAUTHOR_RE:-^Co-Authored-By: Claude (Opus|Sonnet|Haiku|Fable)( [1-9][0-9]*(\.[0-9]+)?)? <noreply@anthropic\.com>\$}"

# 복사 블록에 찍힐 값은 **한 줄이어야 한다.** grep 은 줄마다 맞춰 보므로, 줄바꿈이 섞인 값은
# 첫 줄만 맞으면 통과하고 나머지 줄이 "그대로 붙이세요" 블록에 섞여 출력된다(실측 — 지어낸
# 줄이 블록 안에 들여쓰기까지 맞춰 찍혔다). 에이전트는 그 블록을 복사한다.
one_line() {  # $1=이름 $2=값
  case "$2" in
    *$'\n'*|*$'\r'*) fail "$1 에 줄바꿈이 섞여 있습니다 — 한 줄이어야 합니다." ;;
  esac
}

if [ -n "${CLAUDE_COAUTHOR:-}" ]; then
  COAUTHOR="$CLAUDE_COAUTHOR"; COAUTHOR_FROM="CLAUDE_COAUTHOR"
else
  COAUTHOR="${COMMIT_TRAILER_COAUTHOR:-}"; COAUTHOR_FROM="project.env 의 COMMIT_TRAILER_COAUTHOR"
fi
one_line "$COAUTHOR_FROM" "$COAUTHOR"
# grep -q 대신 출력 버리기 — postflight 와 같은 형태로 둔다(거기서는 -q 가 SIGPIPE 를 낸다).
printf '%s\n' "$COAUTHOR" | grep -E "$COAUTHOR_RE" >/dev/null || fail "$COAUTHOR_FROM 가 공동 작성자 줄의 모양이 아닙니다:
      받은 값  $COAUTHOR
      기대 모양 $COAUTHOR_RE"

# 세션 링크도 같은 블록에 찍히므로 같은 이유로 검사한다(검증에서 같은 모양의 구멍이 한 줄
# 옆에 있었다). URL 이므로 **공백·제어문자·비ASCII 없는 인쇄 가능 ASCII** 로 제한한다 —
# 모양(도메인·경로)은 묻지 않는다. 그것까지 고정하면 링크 형식이 바뀔 때 또 막힌다.
if [ -n "${CLAUDE_SESSION_URL:-}" ]; then
  one_line CLAUDE_SESSION_URL "$CLAUDE_SESSION_URL"
  # 역슬래시도 막는다 — 블록에는 한 줄로 찍혀 무해해 보여도, 에이전트가 메시지를 `echo -e`
  # 로 만들면 `\n` 이 풀려 지어낸 줄이 생긴다(검증 실측). URL 에는 역슬래시가 필요 없다.
  case "$CLAUDE_SESSION_URL" in
    *\\*) fail "CLAUDE_SESSION_URL 에 역슬래시가 섞여 있습니다: $CLAUDE_SESSION_URL" ;;
  esac
  printf '%s\n' "$CLAUDE_SESSION_URL" | LC_ALL=C grep -E '^[!-~]+$' >/dev/null \
    || fail "CLAUDE_SESSION_URL 에 공백·제어문자·비ASCII 문자가 섞여 있습니다: $CLAUDE_SESSION_URL"
fi

printf '\n  커밋 메시지 끝에 이 줄을 그대로 붙이세요 (지어내지 마세요):\n\n'
printf '    %s\n' "$COAUTHOR"
if [ -n "${CLAUDE_SESSION_URL:-}" ]; then
  printf '    Claude-Session: %s\n' "$CLAUDE_SESSION_URL"
fi
# 경고는 **복사할 줄들 뒤에** 모아 찍는다 — 사이에 끼면 블록을 복사할 때 경고문이 커밋
# 메시지에 섞이거나 뒷줄이 빠진다.
printf '\n  (위 줄들은 보기 좋게 들여 찍었을 뿐이다 — 커밋에는 **줄 앞 공백 없이** 붙인다.)\n'
if [ -z "${CLAUDE_COAUTHOR:-}" ]; then
  printf '\n  \033[33m공동 작성자 줄은 project.env 의 기본값입니다 (CLAUDE_COAUTHOR 미설정).\n'
  printf '  지금 이 작업을 하는 모델과 다르면 브리프에 적힌 줄을 쓰세요.\033[0m\n'
fi
if [ -z "${CLAUDE_SESSION_URL:-}" ]; then
  printf '\n  \033[33m세션 링크 줄은 브리프에 적힌 것을 쓰세요 (CLAUDE_SESSION_URL 미설정).\033[0m\n'
fi
if [ -n "${COMMIT_TRAILER_COAUTHOR_RE:-}" ]; then
  printf '\n  \033[33m공동 작성자 줄의 모양을 project.env 가 재정의했습니다: %s\033[0m\n' "$COMMIT_TRAILER_COAUTHOR_RE"
fi

# ── 5. 참고 정보 ──────────────────────────────────────────────────────
printf '\n  검증 명령   %s\n' "${VERIFY_CMD:-(project.env 에 VERIFY_CMD 없음)}"
printf '  보고서 경로 %s/%s.md  (형식: .claude/ops/templates/report.md — 맨 앞 「## 요약」 20줄 이내)\n' "$REPORT_DIR" "$(echo "$CUR" | tr '/' '-')"
[ -n "${PROTECTED_PATHS:-}" ] && printf '  수정 금지   %s\n' "$PROTECTED_PATHS"
[ -n "${ENV_NOTES:-}" ] && printf '\n  환경 제약   %s\n' "$ENV_NOTES"

printf '\n  긴 명령은 요약만:  bash .claude/ops/bin/run-quiet.sh -- <명령>   (전체 로그는 파일, 종료 코드 보존)\n'
printf '  작업을 끝내면:    bash .claude/ops/bin/postflight.sh\n'
printf '  규약 전문:        .claude/ops/docs/CONVENTIONS.md  (이 스크립트와 postflight 는 읽지 말고 실행만)\n\n'
