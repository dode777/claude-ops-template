# 새 서비스에 붙이는 절차

다른 서비스 저장소가 이 템플릿을 받아 쓰게 만드는 순서다. 명령은 그대로 복사해 붙이면 된다.
`< >` 로 표시한 곳만 자기 값으로 바꾼다. 처음 한 번 30분 정도 걸린다.

## 0. 준비물

- 서비스 저장소를 클론한 터미널(로컬이든 Claude 세션이든)
- `git`, `node` 18 이상 — 확인:

  ```bash
  git --version && node --version
  ```

- 템플릿 주소. 아래 명령들은 이 변수를 쓴다(터미널을 새로 열면 다시 넣는다):

  ```bash
  TEMPLATE_URL=https://github.com/<계정>/claude-ops-template.git
  ```

## 1. 작업 브랜치 만들기

서비스 저장소의 최상위에서:

```bash
git fetch origin
git checkout -b claude/adopt-claude-ops origin/main     # 기본 브랜치가 main 이 아니면 바꾼다
```

## 2. 기존 설정 확인 (있을 때만)

`.claude/settings.json` 이 이미 있으면, 그 안의 **서비스만의 설정**(권한 규칙 등)을 오버레이로 먼저 옮긴다.
없으면 3번으로.

```bash
cat .claude/settings.json 2>/dev/null || echo "없음 — 3번으로"
```

있다면 `.claude/settings.overlay.json` 을 만들어 서비스 고유 부분만 옮긴다. 예:

```json
{
  "permissions": { "deny": ["Read(./data/huge.json)"] }
}
```

(사용량 훅처럼 템플릿 `settings.base.json` 에 이미 있는 것은 옮기지 않는다 — 병합 결과에 들어간다.)
init 이 기존 파일과 병합 결과가 **의미상 다르면 멈추고** 알려 주므로 설정을 조용히 잃지 않는다.

## 3. 템플릿 받기 (init)

```bash
rm -rf /tmp/claude-ops-template
git clone --quiet --depth 1 "$TEMPLATE_URL" /tmp/claude-ops-template
node /tmp/claude-ops-template/bin/claude-ops.js init --source "$TEMPLATE_URL" --ref latest
```

(`/tmp/claude-ops-template` 는 CLI 를 한 번 실행하려고 받은 사본이다 — 끝나면 지워도 된다. 실제로 쓰는 파일은
`--ref` 가 가리키는 태그에서 받아 이 저장소에 넣고, 버전은 `.claude/ops.lock` 에 남는다.)

생기는 것:

| 파일 | 무엇 | 누가 고치나 |
|---|---|---|
| `.claude/ops/**` · `.claude/agents/ops-*` · `.claude/skills/ops-*` | 관리 파일(규약·스크립트·에이전트 정의) | **템플릿에서만** |
| `.claude/settings.json` | 생성물(base + overlay) | 직접 고치지 않는다 |
| `.claude/ops.lock` | 템플릿 버전·파일 지문 | 손으로 고치지 않는다 |
| `CLAUDE.md` · `.claude/project.env` · `.claude/settings.overlay.json` · `.claude/orchestrator.local.md` | 오버레이(이 서비스의 지식·값) | 이 저장소 |
| `.github/workflows/claude-ops-check.yml` · `claude-ops-sync.yml` | 검사·자동 동기화 | 이 저장소 |

이미 있던 `CLAUDE.md` 등 오버레이는 **덮지 않는다**("둠" 으로 표시된다).

## 4. 오버레이 채우기

1. **`.claude/project.env`** — 각 줄의 주석대로. 특히:
   - `DEFAULT_BRANCH` — 실제 기본 브랜치
   - `VERIFY_CMD` — 에이전트가 끝내기 전에 돌릴 명령. **직접 한 번 돌려 보고** 통과하는 것을 넣는다
     (항상 실패하는 명령을 넣으면 모든 에이전트가 거기서 막힌다)
   - `PROTECTED_PATHS` — 에이전트가 고치면 안 되는 경로(데이터·바이너리·릴리즈 워크플로 등)
2. **`CLAUDE.md`** — 이미 있으면 맨 위 근처에 아래 절을 붙인다(없으면 init 이 만든 틀을 채운다):

   ````markdown
   ## 에이전트 작업 규약

   공통 규약은 템플릿(claude-ops)에서 온다 — `.claude/ops.lock` 이 버전을 고정한다. 관리 파일은 여기서 고치지 않는다.

   ```bash
   bash .claude/ops/bin/preflight.sh    # 시작 전 — 읽지 말고 실행만
   bash .claude/ops/bin/postflight.sh   # 끝낸 뒤 — 보고서(맨 앞 요약 20줄)·L2 답변·트레일러·관리 파일
   ```

   - 작업 에이전트: `.claude/ops/docs/CONVENTIONS.md`(L1·L2). 보고서 틀 `.claude/ops/templates/report.md`.
   - **세션을 지휘한다면**(에이전트를 띄운다면) 먼저 `.claude/skills/ops-orchestrator/SKILL.md` 와
     `.claude/orchestrator.local.md` 를 읽는다(사람은 `/ops-orchestrator`).
   ````

   CLAUDE.md 는 **모든 에이전트에 자동으로 들어간다** — 「빼면 에이전트가 실수하는가」 로 거른 서비스 불변식만 남긴다.
3. **`.claude/settings.overlay.json`** — 서비스만의 설정. 고쳤으면 다시 만든다:

   ```bash
   node .claude/ops/bin/claude-ops.js settings
   ```

4. **`.claude/orchestrator.local.md`** — 지휘자만 알면 되는 서비스 사정(브랜치 계열 관계 등). 없으면 비워 둔다.

## 5. 확인

```bash
node .claude/ops/bin/claude-ops.js check
node .claude/ops/bin/claude-ops.js status
```

둘 다 `lock 과 일치 ✔` 가 나오면 된다.

## 6. 커밋 · 푸시 · PR

```bash
git add -A
git commit -m "claude-ops 템플릿 도입"
git push -u origin claude/adopt-claude-ops
```

PR 을 만들고, CI 가 초록이면 머지한다. 머지 뒤 처음 시작하는 Claude 세션부터 새 훅·에이전트·skill 이 적용된다
(이미 떠 있는 세션은 훅을 세션 시작 때 한 번 읽어 두므로 그대로다).

## 7. 저장소 설정 (한 번)

GitHub 저장소 → **Settings → Actions → General → Workflow permissions** 에서
「**Allow GitHub Actions to create and approve pull requests**」 를 켠다 — 자동 동기화 PR 을 만들려면 필요하다.

선택: **Settings → Secrets and variables → Actions** 에 `CLAUDE_OPS_TOKEN` 을 넣으면
(이 저장소의 contents·pull-requests 쓰기 권한이 있는 토큰) 자동 동기화 PR 에서도 CI 가 바로 돈다.
없으면 PR 은 만들어지지만 CI 는 PR 을 닫았다 다시 열어야 돈다(GitHub 규칙 — GITHUB_TOKEN 으로 만든 PR 은 다른 워크플로를 깨우지 않는다).
템플릿이 공개 저장소면 템플릿을 받는 데에는 토큰이 필요 없다.

## 8. 그다음 — 템플릿이 바뀌면

- **자동**: 매주 월요일 `claude-ops sync` 워크플로가 최신 태그를 받아 바뀌었으면 PR 을 연다. 검토하고 머지한다.
- **바로 받고 싶으면**: GitHub → Actions → 「claude-ops sync」 → Run workflow. 또는 터미널에서:

  ```bash
  node .claude/ops/bin/claude-ops.js sync --ref latest
  git add -A && git commit -m "claude-ops 템플릿 동기화" && git push
  ```

## 9. 막혔을 때

| 증상 | 할 일 |
|---|---|
| `관리 파일이 lock 과 다르다` | 관리 파일을 이 저장소에서 고친 것이다. 되돌리거나(`git checkout -- <파일>`), 필요한 변경이면 **템플릿에** 올린다 |
| 급하게 이 저장소에서만 고쳐야 한다 | `.claude/ops.lock` 의 `"overrides": []` 에 `{"path": "<파일>", "reason": "<왜·언제 지울지>"}` 를 넣는다. check 가 경고로 계속 알린다 |
| `settings.json — base + overlay 병합 결과와 다르다` | `settings.json` 을 직접 고친 것이다. `.claude/settings.overlay.json` 으로 옮기고 `node .claude/ops/bin/claude-ops.js settings` |
| init/sync 가 `이미 있고 … 병합 결과와 다르다` 로 멈춤 | 2번(기존 설정을 오버레이로)을 하고 다시. 바뀌는 것을 확인했으면 `--adopt-settings` |
| `템플릿을 받지 못했다` | 주소(`TEMPLATE_URL`, `.claude/ops.lock` 의 `source.url`)와 네트워크 확인. 템플릿이 비공개면 `CLAUDE_OPS_TOKEN` 환경변수 |
| `vX.Y.Z 태그가 없다` | 템플릿에 아직 태그가 없다. `--ref main` 처럼 브랜치를 준다 |

## 부록 A. Claude 세션에 맡기기

Claude Code 세션에 아래를 붙이면 1~6번을 대신한다(머지는 사람이):

```
이 저장소에 claude-ops 템플릿을 붙여 줘. 템플릿 주소는 <TEMPLATE_URL>.
템플릿의 docs/ADOPT.md 절차를 그대로 따르고, 기존 .claude/settings.json 의 서비스 고유 설정은 settings.overlay.json 으로 옮겨서
병합 결과가 기존과 의미상 같은지 jq 로 확인해. CLAUDE.md 의 서비스 불변식 문장은 의미를 바꾸지 말고 「에이전트 작업 규약」 절만
붙여. 브랜치 claude/adopt-claude-ops 에 커밋하고 푸시까지만 — PR·머지는 하지 마.
```

## 부록 B. 이미 규약 복사본(템플릿 이전 방식)이 있는 저장소

예전 방식(규약 파일을 저장소마다 복사하고 지문 파일로 대조)이 남아 있으면:

- 옛 파일(`.claude/CONVENTIONS.md` · `.claude/bin/*.sh` · `.claude/templates/*` · 지문 lock)은 **다른 저장소가 모두 템플릿으로 옮길 때까지 지우지 않는다**
  — 옛 지문 대조가 두 저장소의 같은 내용을 전제로 하기 때문이다. 새 preflight/postflight 는 옛 지문 검사 스크립트가 있으면 그것도 함께 돌린다.
- CLAUDE.md 의 실행 경로만 새 경로(`.claude/ops/bin/…`)로 바꾸고, 옛 경로는 그대로 둔다(진행 중인 세션이 쓴다).
- 훅이 가리키던 옛 경로(`.claude/bin/usage-guard.py` 등)는 새 파일로 넘기는 **위임 스크립트**로 남긴다(이미 떠 있는 세션이 그 경로를 부른다).
- 모든 저장소가 옮긴 뒤 한 번에 지운다.
