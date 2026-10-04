#!/usr/bin/env bash
# .claude/ops/bin/run-quiet.sh — 긴 명령(테스트 등)을 돌리고 **요약과 실패 블록만** 출력한다.
#
#   bash .claude/ops/bin/run-quiet.sh [--label 이름] [--log 파일] -- <명령> [인자...]
#   bash .claude/ops/bin/run-quiet.sh -- xvfb-run -a npm run test:changed
#
# 지키는 것
#   · **종료 코드를 그대로 돌려준다.** `명령 | grep … | head` 는 파이프의 마지막(grep·head)의 종료 코드가 되어
#     실패한 테스트가 초록으로 보인다 — 공식 문서의 예시도 이 함정을 갖고 있다. 여기서는 명령의 출력을 파일로
#     보내고 명령 자신의 종료 코드를 잡는다.
#   · **전체 출력은 파일에 그대로 남긴다.** 「검증 출력을 자르지 말라」(오케스트레이터 규약 10)는 컨텍스트에
#     전부 넣으라는 뜻이 아니라 **잃지 말라**는 뜻이다. 화면에는 요약만, 실패를 따라갈 때는 파일의 그 블록 전체를 읽는다.
#   · **로그 경로는 실행마다 고유하다.** 두 에이전트가 같은 경로에 로그를 써서 서로의 결과를 섞은 사고가 있었다.
#     기본 경로는 mktemp 로 만들고, --log 로 정해도 이미 있는 파일이면 덮지 않고 거절한다.
#
# 환경변수
#   RUN_QUIET_FAIL_RE   실패 줄을 고르는 확장 정규식 (기본: FAIL|✗|✘|not ok|Error|AssertionError|failed|실패)
#   RUN_QUIET_TAIL      끝에서 보여 줄 줄 수 (기본 15 — 보통 「N/M 통과」 요약이 여기 있다)
#   RUN_QUIET_MAX       실패 블록으로 보여 줄 최대 줄 수 (기본 200 — 넘치면 줄 번호만 알리고 파일을 가리킨다)
#   CLAUDE_OPS_LOG_DIR  기본 로그 디렉터리 (기본 ${TMPDIR:-/tmp}/claude-ops-logs)

set -u

LABEL="run"
LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:-run}"; shift 2 ;;
    --log)   LOG="${2:-}"; shift 2 ;;
    --)      shift; break ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) break ;;
  esac
done
[ $# -eq 0 ] && { echo "[run-quiet] 돌릴 명령이 없다 — run-quiet.sh [옵션] -- <명령>" >&2; exit 2; }

FAIL_RE="${RUN_QUIET_FAIL_RE:-FAIL|✗|✘|not ok|Error|AssertionError|failed|실패}"
TAIL_N="${RUN_QUIET_TAIL:-15}"
MAX_N="${RUN_QUIET_MAX:-200}"

if [ -z "$LOG" ]; then
  DIR="${CLAUDE_OPS_LOG_DIR:-${TMPDIR:-/tmp}/claude-ops-logs}"
  mkdir -p "$DIR" || { echo "[run-quiet] 로그 디렉터리를 만들지 못했다: $DIR" >&2; exit 2; }
  SAFE="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '_')"
  LOG="$(mktemp "$DIR/${SAFE}.$(date +%Y%m%d-%H%M%S).XXXXXX")" || { echo "[run-quiet] 로그 파일을 만들지 못했다" >&2; exit 2; }
  mv "$LOG" "$LOG.log" && LOG="$LOG.log"
else
  if [ -e "$LOG" ]; then
    echo "[run-quiet] 로그 파일이 이미 있다 — 다른 실행의 로그를 덮지 않는다: $LOG" >&2
    exit 2
  fi
  mkdir -p "$(dirname "$LOG")"
fi

START=$(date +%s)
"$@" >"$LOG" 2>&1
RC=$?
SECS=$(( $(date +%s) - START ))
LINES=$(wc -l <"$LOG" | tr -d ' ')

printf '[run-quiet] %s\n' "$*"
printf '[run-quiet] 종료 코드 %s · %s초 · 출력 %s줄 · 전체 로그 %s\n' "$RC" "$SECS" "$LINES" "$LOG"

# 실패 블록 — 일치 줄 앞 3줄 · 뒤 12줄. 종료 코드가 0 이어도 보인다(경고성 실패 문구를 놓치지 않게).
HITS=$(grep -cE -- "$FAIL_RE" "$LOG" 2>/dev/null || true)
if [ "${HITS:-0}" -gt 0 ]; then
  BLOCK="$(grep -nE -B3 -A12 -- "$FAIL_RE" "$LOG")"
  BN=$(printf '%s\n' "$BLOCK" | wc -l | tr -d ' ')
  printf '\n[run-quiet] 실패 후보 %s곳 (정규식: %s)\n' "$HITS" "$FAIL_RE"
  if [ "$BN" -le "$MAX_N" ]; then
    printf '%s\n' "$BLOCK"
  else
    printf '%s\n' "$BLOCK" | head -n "$MAX_N"
    printf '[run-quiet] … 실패 블록 %s줄 중 %s줄만 보였다 — 나머지는 로그 파일에 그대로 있다:\n' "$BN" "$MAX_N"
    printf '            grep -nE -B3 -A12 -- %q %q\n' "$FAIL_RE" "$LOG"
  fi
fi

printf '\n[run-quiet] 끝 %s줄:\n' "$TAIL_N"
tail -n "$TAIL_N" "$LOG"

if [ "$RC" -ne 0 ]; then
  printf '\n[run-quiet] 실패 (종료 코드 %s) — 위 블록과 로그 파일을 본다.\n' "$RC"
fi
exit "$RC"
