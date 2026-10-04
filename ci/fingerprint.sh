#!/usr/bin/env bash
# ci/fingerprint.sh — 「테스트 결과를 바꿀 수 있는 내용」 의 지문(40자)을 출력한다.
#
#   bash ci/fingerprint.sh [--exclude <pathspec>]... [--include <경로>]...
#   예) bash ci/fingerprint.sh --exclude docs --exclude '*.md' --exclude .claude --include docs/read-by-tests.md
#
# 추적 파일의 blob 해시 목록(git ls-files -s)을 sha256 으로 묶는다. 커밋 SHA 가 아니라 **내용**이 키라서,
# PR 에서 통과한 내용이 머지 뒤 main · 릴리즈에서 그대로면 같은 지문이 나온다 → 다시 돌리지 않아도 된다.
#
# 함정 두 가지(실측):
#   · 문서를 통째로 빼면 **테스트가 실제로 읽는 문서**가 바뀌어도 다시 돌지 않는다 → --include 로 되살린다.
#   · 지문은 러너 이미지·외부 다운로드(브라우저·런타임 바이너리) 변화를 모른다. 보존 기간(예: 90일) 동안 같은
#     내용이면 다시 검증하지 않는다는 뜻이므로, 그 한계를 릴리즈 문서에 적어 둔다.
set -euo pipefail
EX=(); IN=()
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude) EX+=(":(exclude)$2"); shift 2 ;;
    --include) IN+=("$2"); shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
{
  git ls-files -s -- . "${EX[@]}"
  if [ ${#IN[@]} -gt 0 ]; then git ls-files -s -- "${IN[@]}"; fi
} | sha256sum | cut -c1-40
