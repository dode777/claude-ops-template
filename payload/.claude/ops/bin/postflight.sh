#!/usr/bin/env bash
# .claude/ops/bin/postflight.sh — 작업을 끝내기 전 기계 검사 (L1).
#
# 보고서가 있는지, 맨 앞 요약이 짧은지, L2 여섯 항목에 답이 있는지, 커밋 트레일러가 맞는지,
# 관리 파일(템플릿에서 온 것)이 그대로인지 본다.
# **답의 내용은 판단하지 않는다** — 비어 있는지만 본다. 판단은 사람이 한다.
#
# **에이전트는 이 파일을 읽지 말고 실행만 한다** — 아래 근거 주석은 이 스크립트를 고치는 사람을 위한 것이다.
#
# ── 기준점(BASE) 은 선언하지 않는다 — 계산한다 ──────────────────────────
# 한때 `BASE_REF` 환경변수로 기준점을 선언할 수 있었다. 동기는 타당했다 — 태그에서 잘라 낸
# 릴리즈 브랜치에서 `origin/main..HEAD` 로 커밋을 고르면 **작업하지 않은 남의 커밋**이 검사
# 대상에 들어와 오탐이 났다. 그런데 그 해법은 두 가지를 동시에 망쳤다:
#
#   · 우회가 열렸다 — `BASE_REF=HEAD~3` 처럼 기준점을 넉넉히 잡으면 검사 대상이
#     13개에서 5개로 줄고 그대로 통과한다(정적 검증자가 실측). 노란 경고와
#     "검사 대상 N개" 출력은 **사람이 읽어야 의미가 있는 신호**일 뿐이고, 스크립트는
#     그 값이 실제 분기점인지 검증하지 않았다. L1 은 "판단할 것이 없다" 는 전제로
#     서 있는데 BASE_REF 는 판단을 요구한다.
#   · 오탐이 안 없어졌다 — 후보 3개를 다 돌려도 머지 커밋에서 게이트가 계속
#     exit 1 이었다(작업자 확인). **범위(range) 를 옮기는 것으로는 원인을 못
#     짚기 때문이다.** 원인은 "기준점이 틀렸다" 가 아니라 아래 두 가지였다.
#
# ── 원인 1. 머지 커밋은 반대쪽 부모의 이력을 전부 데려온다 ──────────────
# `git rev-list BASE..HEAD` 는 "HEAD 에서 도달하고 BASE 에서 도달하지 않는 커밋"
# 이다. 머지 커밋이 끼면 여기에 **반대쪽 부모의 이력 전체**가 들어온다. 실측: 검사 대상
# 22개 중 트레일러가 없는 것은 두 개였는데, 둘 다 릴리즈 브랜치가 기본 브랜치에서
# **체리픽해 온 사람 커밋**이고 그 원본은 이미 BASE 에 있었다. 새로 들여오는 변경이
# 아닌데 매번 걸렸다.
#
# 그래서 범위를 줄이는 대신 **커밋 단위로 면제**한다: 트레일러가 없는 커밋에 대해서만
# "이 패치가 이미 기준 브랜치에 있는가" 를 묻는다. 실측으로 확인한 판정 방법:
#   · `git cherry BASE HEAD` 는 **이 상황에서 구조적으로 못 쓴다.** git cherry 는
#     비교 대상을 `HEAD..BASE` 로 잡는데, 머지 커밋의 첫 부모가 BASE 이면 그 범위가
#     비어 전부 `+`(새것)로 나온다. 실제로 22개 전부 `+` 였다.
#   · `git merge-base --is-ancestor <체리픽> BASE` 도 안 된다 — 체리픽은 SHA 가
#     달라서 조상이 아니다(실측 NOT-ancestor).
#   · `git patch-id --stable` 은 **맞는다.** 체리픽과 원본의 patch-id 가 쌍마다 같았다.
# patch-id 계산은 커밋당 diff 한 번이라 비싸다. 그래서 **트레일러 검사에 걸린
# 커밋에 대해서만** 돌리고, 후보는 기준 브랜치에서 작성자 메일+작성 시각이 같거나
# 제목이 같은 커밋으로 먼저 좁힌다(체리픽은 작성자·작성 시각을 보존한다 — 실측).
#
# 범위를 `--first-parent` 로 좁히는 방법도 있지만 **쓰지 않았다.** 그러면 머지로
# 데려온 쪽이 전부 검사에서 빠져, 자기 커밋을 옆 브랜치에 쌓고 머지하는 것만으로
# 트레일러 검사를 통째로 피할 수 있다(실측 사례에서 검사 대상이 22개 → 1개).
#
# ── 원인 2. 보호 경로 검사가 두 점 diff 라서 방향이 뒤집혔다 ────────────
# `git diff BASE..HEAD` 는 두 트리의 차이다. 브랜치가 BASE 의 자손이 아니면
# **기본 브랜치가 그 뒤에 고친 것**이 "이 브랜치가 수정·삭제했다" 로 거꾸로 잡힌다
# (실측: 남이 추가한 마이그레이션 파일·릴리즈 워크플로가 "수정" 으로 보고됐고, 세 점은 깨끗했다).
# merge-base 는 **그래프에서 계산되는 값**이라 환경변수로 옮길 수 없다. 그래서
# 세 점(`BASE...HEAD`)으로 바꾸면 오탐이 사라지면서 우회 표면도 늘지 않는다.
#
# ── 거부권은 남긴다. 다만 범위가 아니라 항목 단위로 ─────────────────────
# 이 규약은 "안 했으면 이유를 적으면 된다" 를 원칙으로 한다. 그래서 게이트를
# 무조건 막지 않고 두 개의 면제 스위치를 둔다:
#
#     ACCEPT_UNTRAILERED=<sha>,<sha>   bash .claude/ops/bin/postflight.sh
#     ACCEPT_PROTECTED=<경로>           bash .claude/ops/bin/postflight.sh
#
# `BASE_REF` 와 결정적으로 다른 점: **무엇을 면제했는지가 유한하게 적힌다.**
# 기준점을 옮기면 무엇이 빠졌는지 아무도 모르지만, 여기서는 SHA·경로를 하나하나
# 이름으로 적어야 하고, **그 문자열이 보고서에 없으면 통과하지 않는다.** 면제된 항목은
# 항상 출력에 나열된다.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # .claude
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1

# 트레일러 모양의 재정의는 **project.env 에서만** 받는다 — preflight 와 같은 이유(오케스트레이터 규약 12).
# 환경변수 하나로 커밋 검사가 조용히 꺼지면 ACCEPT_UNTRAILERED 를 기록 없이 우회하게 된다.
# `unset` 이 아니라 대입으로 비운다 — preflight 주석 참고(함수로 가로챌 수 없다).
COMMIT_TRAILER_COAUTHOR_RE=
# 요약 줄 수 상한도 project.env 에서만 — 환경변수로 늘려 검사를 끄지 못하게.
REPORT_SUMMARY_MAX_LINES=
# git replace 로 바꿔치기한 커밋 메시지를 보지 않는다 — preflight 주석 참고.
export GIT_NO_REPLACE_OBJECTS=1
if [ ! -f "$HERE/project.env" ]; then
  printf '\033[31m[postflight] .claude/project.env 가 없습니다 (claude-ops init 참고).\033[0m\n' >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$HERE/project.env"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
REPORT_DIR="${REPORT_DIR:-.claude/reports}"
VERIFY_CMD="${VERIFY_CMD:-}"
SUMMARY_MAX="${REPORT_SUMMARY_MAX_LINES:-20}"

PROBLEMS=()
add() { PROBLEMS+=("$1"); }
note() { printf '  %s\n' "$1"; }

CUR="$(git rev-parse --abbrev-ref HEAD)"
BASE="origin/$DEFAULT_BRANCH"
REPORT="$REPORT_DIR/$(echo "$CUR" | tr '/' '-').md"

printf '\n[postflight] %s\n\n' "$CUR"

# BASE_REF 은 없어졌다. 조용히 무시하면 "기준점을 선언했다" 고 믿은 채로 다른 것을
# 검사하게 되므로, 설정돼 있으면 멈추고 알려준다.
if [ -n "${BASE_REF:-}" ]; then
  printf '\033[31m[postflight] BASE_REF 는 없어졌습니다.\033[0m\n\n' >&2
  printf '  기준점은 항상 %s 이고, 머지 커밋 오탐은 기준점을 옮기는 대신\n' "$BASE" >&2
  printf '  · 트레일러: 패치가 이미 기준 브랜치에 있는 커밋을 면제\n' >&2
  printf '  · 보호 경로: 세 점 diff(merge-base 기준)\n' >&2
  printf '  로 해결합니다. 그래도 면제가 필요하면 항목 단위로 적으세요:\n' >&2
  printf '      ACCEPT_UNTRAILERED=<sha>[,<sha>...]   ACCEPT_PROTECTED=<경로>[,<경로>...]\n' >&2
  printf '  (면제한 SHA·경로는 보고서에도 적혀 있어야 통과합니다.)\n\n' >&2
  exit 1
fi

# ── 0. 관리 파일 (템플릿에서 온 것) ───────────────────────────────────
# 관리 파일을 소비자 저장소에서 직접 고치면 실패한다 — 고치는 곳은 템플릿 한 곳이다(중앙관리).
# 급한 경우의 탈출구는 ops.lock 의 overrides(사유 필수, check 가 계속 경고).
if [ -f "$HERE/ops.lock" ]; then
  if command -v node >/dev/null 2>&1; then
    OPS_OUT="$(node "$HERE/ops/bin/claude-ops.js" check --root "$ROOT" 2>&1)"
    OPS_RC=$?
    printf '%s\n' "$OPS_OUT"
    if [ "$OPS_RC" -ne 0 ]; then
      add "관리 파일이 .claude/ops.lock 과 다릅니다(위 claude-ops 출력).
        관리 파일은 템플릿에서 고치고 \`node .claude/ops/bin/claude-ops.js sync --ref <버전>\` 으로 받습니다.
        settings.json 이면 .claude/settings.overlay.json 을 고치고 \`node .claude/ops/bin/claude-ops.js settings\`."
    fi
  else
    # node 가 없는 환경에서 작업 자체를 막지 않는다(L2-4). CI 의 claude-ops-check 가 같은 것을 본다.
    printf '\033[33m  claude-ops  node 가 없어 관리 파일을 대조하지 못했습니다 (확인 못 함 — CI 가 봅니다).\033[0m\n'
  fi
fi

# 템플릿 도입 이전의 복사본 지문 검사가 남아 있는 저장소는 그 판정도 그대로 따른다
# (로컬·결정적인 검사 — 이 저장소의 공통부가 자기 lock 과 맞는지 — 만 실패로 본다).
if [ -f "$HERE/bin/conventions-hash.sh" ]; then
  DRIFT_OUT="$(bash "$HERE/bin/conventions-hash.sh" --check 2>&1)"
  DRIFT_RC=$?
  printf '%s\n' "$DRIFT_OUT"
  if [ "$DRIFT_RC" -ne 0 ]; then
    add "옛 규약 공통부가 .claude/conventions.lock 과 다릅니다.
        규약을 고쳤다면 갱신하세요:  bash .claude/bin/conventions-hash.sh --write"
  fi
fi

# ── 1. 작업 트리 ──────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  add "작업 트리에 커밋되지 않은 변경이 있습니다:
$(git status --short | sed 's/^/        /')"
else
  note "작업 트리  깨끗함 ✔"
fi

# ── 2. 보고서 존재 ────────────────────────────────────────────────────
# 완료 알림의 결과 필드는 자주 비거나 잘린다. 오케스트레이터는 이 파일을 읽는다.
if [ ! -f "$REPORT" ]; then
  add "보고서가 없습니다: $REPORT
        .claude/ops/templates/report.md 를 복사해 채우세요."
else
  note "보고서  $REPORT ✔"

  # ── 2.5. 맨 앞 요약 ────────────────────────────────────────────────
  # 오케스트레이터와 다음 에이전트는 **요약만** 읽는다. 보고서 원문은 길어지기 쉽고(중앙값 1만 토큰대
  # 실측), 매번 통째로 읽으면 그 비용이 세션 내내 다시 읽힌다. 그래서
  #   · 첫 `## ` 제목이 `## 요약` 이어야 하고
  #   · 그 본문(1열 HTML 주석 · 빈 줄 제외)이 1~SUMMARY_MAX 줄이어야 한다.
  # 주석 처리는 아래 L2 검사와 같은 규칙(1열에서 여는 주석만 주석으로 본다).
  SUMMARY_INFO="$(awk '
    /^## / { n++; if (n == 1) { first = $0; on = ($0 ~ /^## 요약[[:space:]]*$/); next } else { on = 0 } }
    !on { next }
    /^<!--/ { if ($0 !~ /-->/) incomment=1; next }
    incomment { if ($0 ~ /-->/) incomment=0; next }
    /^[[:space:]]*$/ { next }
    /^---+$/ { next }
    { lines++ }
    END { printf "%s\t%d\n", (first == "" ? "(없음)" : first), lines + 0 }
  ' "$REPORT")"
  SUMMARY_HEAD="${SUMMARY_INFO%%$'\t'*}"
  SUMMARY_LINES="${SUMMARY_INFO##*$'\t'}"
  if ! printf '%s\n' "$SUMMARY_HEAD" | grep -E '^## 요약[[:space:]]*$' >/dev/null; then
    add "보고서의 첫 \`## \` 제목이 \`## 요약\` 이 아닙니다 (지금: $SUMMARY_HEAD).
        맨 앞에 결론·바뀐 불변식·남은 위험을 ${SUMMARY_MAX}줄 이내로 적으세요 — 읽는 쪽은 요약만 읽습니다."
  elif [ "$SUMMARY_LINES" -lt 1 ]; then
    add "보고서의 \`## 요약\` 이 비어 있습니다."
  elif [ "$SUMMARY_LINES" -gt "$SUMMARY_MAX" ]; then
    add "보고서의 \`## 요약\` 이 ${SUMMARY_LINES}줄입니다 — ${SUMMARY_MAX}줄 이내로 줄이세요(자세한 것은 아래 절로)."
  else
    note "요약  ${SUMMARY_LINES}/${SUMMARY_MAX}줄 ✔"
  fi

  # ── 3. L2 여섯 항목에 답이 있는지 ───────────────────────────────────
  # 제목 다음에 내용이 있는지만 본다. 내용의 옳고 그름은 보지 않는다.
  #
  # 네 가지를 실제로 돌려보다가 잡았다(전부 재현·확인):
  #
  #   1. 템플릿의 안내문이 <!-- ... --> HTML 주석이라, 걷어내지 않고 그대로
  #      awk 에 넘기면 "비어 있는 섹션"도 주석 텍스트 때문에 비어 있지 않은
  #      것으로 잘못 판정된다 — report.md 를 안내문만 있는 채로 그대로
  #      제출해도 "6/6 채워짐"으로 통과해 버린다.
  #   2. 다음 섹션 시작을 찾는 `/^#{2,3} /`(중괄호 구간 반복)가 기본 awk 가 mawk 인
  #      환경에서는 **구간 표현으로 해석되지 않고 리터럴로 처리된다**
  #      (`awk 'BEGIN{print ("###" ~ /^#{2,3}$/)}'` → 0). 그 결과
  #      "다음 섹션 시작"을 영영 못 찾아 매 섹션이 그 뒤 파일 끝까지 전부를
  #      본문으로 삼켜버린다 — 즉 **어떤 항목을 비워도 그 뒤에 다른 항목이
  #      하나라도 채워져 있으면 항상 "채워짐"으로 오판**한다(치명 — 이
  #      규약의 핵심 게이트가 사실상 상시 통과였다는 뜻이다). `{2,3}` 대신
  #      교대(`|`)로 바꿔 mawk/gawk 양쪽에서 동일하게 동작하게 했다.
  #   3. 위 두 개를 고친 뒤에도 **"6. 미확인 목록"만은 항목을 비워도 항상
  #      "채워짐"으로 나왔다.** 템플릿에서 이 항목 바로 다음이 "###" 헤딩이
  #      아니라 구분선 `---`(그 다음에야 "## 검증 결과")이기 때문에, `---`
  #      한 줄이 본문으로 잡혀 공백이 아닌 것으로 판정됐다. 그래서 경계
  #      조건에 `---` 구분선도 추가했다.
  #   4. 1번을 "검사 전에 sed 로 주석을 지운 사본을 만든다" 로 고쳤더니 그
  #      자체가 결함이었다 — 주석 문법을 **본문에서 언급하는** 보고서에서
  #      `sed '/<!--/,/-->/d'` 의 범위가 열린 채 닫히지 않아 파일이 통째로
  #      잘린다. 실제로 34행 보고서가 6행으로 잘려 여섯
  #      항목 전부가 "비었음" 으로 오판됐다. 그래서 **전처리를 없애고 awk
  #      한 번 안에서 섹션 단위로** 처리한다 — 오작동이 생겨도 그 섹션
  #      하나에 갇힌다. 주석 여는 줄은 **1열에서 시작하는 것만**(/^<!--/)
  #      주석으로 본다. 템플릿의 안내문은 전부 1열에서 시작하고, 본문에서
  #      들여쓰거나 백틱으로 감싸 언급한 것은 1열이 아니다.
  MISSING=()
  while IFS= read -r label; do
    [ -z "$label" ] && continue
    # awk 에 넘기는 것은 key 가 아니라 label — 보고서에 실제로 적힌 제목이다.
    # (처음에 key 를 넘겨 "채워져 있는데 비었다" 고 오판했다.)
    BODY="$(awk -v k="$label" '
      $0 ~ "^### " k { found=1; next }
      !found { next }
      /^(##|###) / || /^---+$/ { exit }
      /^<!--/ { if ($0 !~ /-->/) incomment=1; next }
      incomment { if ($0 ~ /-->/) incomment=0; next }
      { print }
    ' "$REPORT" | tr -d '[:space:]')"
    [ -z "$BODY" ] && MISSING+=("$label")
  done <<'EOF'
1. 진입점 전수
2. 실제 경로를 타는 테스트
3. 수치의 출처
4. 막히면 안 되는 것
5. 공유 자원 변경의 사용처
6. 미확인 목록
EOF

  if [ ${#MISSING[@]} -gt 0 ]; then
    add "보고서의 L2 항목이 비어 있습니다:
$(printf '        - %s\n' "${MISSING[@]}")
        \"해당 없음\" 또는 \"안 했음 + 이유\" 도 정당한 답입니다. 비워두는 것만 안 됩니다."
  else
    note "L2 답변  6/6 채워짐 ✔"
  fi
fi

# ── 면제 스위치 공용 ──────────────────────────────────────────────────
# 쉼표·공백 어느 쪽으로 구분해도 받는다.
split_list() { printf '%s' "${1:-}" | tr ',' ' ' | tr -s ' ' '\n' | grep -v '^$' || true; }

# 면제하려는 항목이 보고서에 이름으로 적혀 있는가. 보고서가 없으면 적혀 있을 수 없다.
mentioned_in_report() {
  [ -f "$REPORT" ] || return 1
  grep -qF -- "$1" "$REPORT"
}

# ── 4. 커밋 트레일러 ──────────────────────────────────────────────────
# 이 패치가 이미 기준 브랜치에 있는가 (체리픽·되돌려 넣기 판정). 위 주석 참고.
PATCH_MATCH=""
patch_already_in_base() {
  local sha="$1" pid ae at subj cands c
  pid="$(git show "$sha" | git patch-id --stable | cut -d' ' -f1)"
  [ -z "$pid" ] && return 1          # 머지 커밋 등 diff 가 없는 커밋은 판정 불가
  ae="$(git log -1 --format='%ae' "$sha")"
  at="$(git log -1 --format='%at' "$sha")"
  subj="$(git log -1 --format='%s' "$sha")"
  cands="$( {
      git log "$BASE" --no-merges --format='%H|%ae|%at' \
        | awk -F'|' -v ae="$ae" -v at="$at" '$2==ae && $3==at {print $1}'
      git log "$BASE" --no-merges --format='%H' --fixed-strings --grep="$subj"
    } 2>/dev/null | sort -u )"
  for c in $cands; do
    if [ "$(git show "$c" | git patch-id --stable | cut -d' ' -f1)" = "$pid" ]; then
      PATCH_MATCH="$c"
      return 0
    fi
  done
  return 1
}

if git rev-parse --verify --quiet "$BASE" >/dev/null; then
  COMMITS="$(git rev-list "$BASE..HEAD")"
  NCOMMITS="$(printf '%s\n' "$COMMITS" | grep -c . || true)"
  if [ "$NCOMMITS" -eq 0 ]; then
    add "$BASE 기준으로 새 커밋이 없습니다."
  else
    # 검사 대상이 몇 개인지 항상 찍는다.
    printf '  검사 대상  %s..%s  커밋 %s개\n' "$BASE" "$CUR" "$NCOMMITS"

    # 공동 작성자 줄은 **정확한 한 문자열이 아니라 모양**으로 본다(오케스트레이터 규약 12). 모델을 작업마다
    # 고르고 한 브랜치 안에서도 바꿀 수 있으므로, 커밋마다 다른 모델 이름이 붙는 것이 정상이다.
    # 한 문자열과 정확히 대조하면 모델을 바꾼 순간 앞선 커밋이 전부 "틀린 트레일러" 가 된다.
    # 대신 모양은 좁게 잡는다 — Claude 의 모델 계열 이름 + 선택적 버전 + 고정 주소. 지어낸
    # 이름(「Claude Banana」)이나 주소가 틀린 줄은 여전히 걸린다.
    # 이 기본 정규식은 preflight 의 것과 **같아야 한다** — 그쪽 주석 참고(갈리면 두 방향 다 나쁘다).
    COAUTHOR_RE="${COMMIT_TRAILER_COAUTHOR_RE:-^Co-Authored-By: Claude (Opus|Sonnet|Haiku|Fable)( [1-9][0-9]*(\.[0-9]+)?)? <noreply@anthropic\.com>\$}"
    [ -n "${COMMIT_TRAILER_COAUTHOR_RE:-}" ] \
      && printf '  트레일러 모양  project.env 가 재정의함: %s\n' "$COMMIT_TRAILER_COAUTHOR_RE"
    ACCEPT_U="$(split_list "${ACCEPT_UNTRAILERED:-}")"
    BAD=(); PORTED=(); WAIVED=(); UNDOCUMENTED=()
    while read -r sha; do
      [ -z "$sha" ] && continue
      # CR 을 지우고 본다 — 예전의 부분 일치(grep -F)는 줄 끝 CR 을 통과시켰는데 줄 단위
      # 정규식(^…$)은 그것을 거부한다. 모양 검사로 바꾸면서 정상 커밋이 걸리게 하지 않는다.
      # **grep -q 를 쓰지 않는다.** pipefail 아래에서 -q 는 일치하는 즉시 끝나고, 뒤에 남은
      # 청크를 쓰던 tr 이 SIGPIPE(141)를 받아 파이프 전체가 실패한다 — 트레일러 뒤에 본문이
      # 4KB 넘게 이어지는 정상 커밋이 가끔 "트레일러 없음" 으로 떨어졌다(적대적 검증 실측:
      # 8KB 커밋 60회 중 2회). 출력을 버리면 grep 이 입력을 끝까지 읽는다.
      git log -1 --format='%B' "$sha" | tr -d '\r' | grep -E "$COAUTHOR_RE" >/dev/null && continue

      if patch_already_in_base "$sha"; then
        PORTED+=("$(git log -1 --format='%h %s' "$sha") — 패치가 이미 $BASE 에 있음 ($(git rev-parse --short "$PATCH_MATCH"))")
        continue
      fi

      SHORT="$(git rev-parse --short "$sha")"
      if printf '%s\n' "$ACCEPT_U" | grep -qx -e "$sha" -e "$SHORT"; then
        if mentioned_in_report "$SHORT"; then
          WAIVED+=("$(git log -1 --format='%h %s' "$sha")")
        else
          UNDOCUMENTED+=("$SHORT")
        fi
        continue
      fi

      BAD+=("$(git log -1 --format='%h %s' "$sha")")
    done <<< "$COMMITS"

    if [ ${#PORTED[@]} -gt 0 ]; then
      printf '  트레일러 면제  %s개 (검사 대상에서 빼지 않고 건별로 면제):\n' "${#PORTED[@]}"
      printf '        %s\n' "${PORTED[@]}"
    fi
    if [ ${#WAIVED[@]} -gt 0 ]; then
      printf '\033[33m  ACCEPT_UNTRAILERED 로 면제  %s개 (보고서에 SHA 가 적혀 있어 통과):\033[0m\n' "${#WAIVED[@]}"
      printf '        %s\n' "${WAIVED[@]}"
    fi

    if [ ${#UNDOCUMENTED[@]} -gt 0 ]; then
      add "ACCEPT_UNTRAILERED 로 면제하려는 커밋이 보고서에 없습니다:
$(printf '        %s\n' "${UNDOCUMENTED[@]}")
        면제는 허용되지만 **보고서에 그 SHA 와 이유를 적어야** 합니다."
    fi

    if [ ${#BAD[@]} -gt 0 ]; then
      add "공동 작성자 트레일러가 없거나 다른 커밋:
$(printf '        %s\n' "${BAD[@]}")
        기대 모양: $COAUTHOR_RE
        (지어내지 말고 preflight 가 출력한 줄을 그대로 쓰세요. 모델을 바꿨다면 그 모델의
         줄을 CLAUDE_COAUTHOR 로 넘겨 preflight 를 다시 돌리면 출력됩니다.
         **줄 앞에 공백이 있으면 안 됩니다** — preflight 는 보기 좋게 들여 찍을 뿐이고,
         git 도 들여쓴 줄을 트레일러로 읽지 않습니다.)
        남의 커밋을 체리픽해 온 것이라면 그 패치가 $BASE 에 있으면 자동으로 면제됩니다.
        그래도 면제가 필요하면 ACCEPT_UNTRAILERED=<sha> 로 적고 보고서에도 적으세요."
    else
      note "커밋 트레일러  검사 대상 전부 공동 작성자 줄의 모양과 일치 ✔"
    fi
  fi
fi

# ── 5. 보호 경로 ──────────────────────────────────────────────────────
# 세 점 diff — merge-base 부터 본다. 두 점으로 보면 기본 브랜치가 그 뒤에 고친 것이
# "이 브랜치가 수정했다" 로 거꾸로 잡힌다(위 주석의 실측 참고).
if [ -n "${PROTECTED_PATHS:-}" ] && git rev-parse --verify --quiet "$BASE" >/dev/null; then
  if git merge-base "$BASE" HEAD >/dev/null 2>&1; then
    RANGE="$BASE...HEAD"
  else
    RANGE="$BASE..HEAD"
    note "보호 경로  $BASE 와 공통 조상이 없어 두 점 diff 로 봅니다"
  fi
  ACCEPT_P="$(split_list "${ACCEPT_PROTECTED:-}")"
  for p in $PROTECTED_PATHS; do
    # 새 파일 추가는 정상(예: 새 마이그레이션). 기존 파일 수정·삭제만 문제 삼는다.
    MODIFIED="$(git diff --diff-filter=MD --name-only "$RANGE" -- "$p")"
    [ -z "$MODIFIED" ] && continue
    if printf '%s\n' "$ACCEPT_P" | grep -qx -- "$p"; then
      if mentioned_in_report "$p"; then
        printf '\033[33m  ACCEPT_PROTECTED 로 면제  %s (보고서에 적혀 있어 통과):\033[0m\n' "$p"
        printf '        %s\n' $MODIFIED
      else
        add "ACCEPT_PROTECTED 로 면제하려는 경로가 보고서에 없습니다: $p
        면제는 허용되지만 **보고서에 그 경로와 이유를 적어야** 합니다."
      fi
      continue
    fi
    add "보호 경로의 기존 파일이 수정·삭제됐습니다 ($p):
$(printf '        %s\n' $MODIFIED)
        정말 필요하면 ACCEPT_PROTECTED=$p 로 적고 보고서에도 그 경로와 이유를 적으세요."
  done
fi

# ── 결과 ──────────────────────────────────────────────────────────────
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  printf '\n\033[31m[postflight] 아직 끝나지 않았습니다:\033[0m\n\n'
  for p in "${PROBLEMS[@]}"; do printf '  - %s\n\n' "$p"; done
  exit 1
fi

[ -n "$VERIFY_CMD" ] && printf '\n  검증 명령을 아직 안 돌렸다면 지금 돌리세요:  %s\n' "$VERIFY_CMD"
printf '\n\033[32m[postflight] 통과.\033[0m\n\n'
