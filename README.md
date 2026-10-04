# claude-ops-template

여러 Claude Code 에이전트를 무인으로 돌려 실제 서비스를 만들 때 쓰는 **운영 규약·도구의 정본**.
각 서비스 저장소는 이 템플릿을 **버전을 고정해 받고**(`.claude/ops.lock`), 자기 지식만 오버레이로 얹는다.

> 템플릿 + 서비스 오버레이 = 그 서비스에 맞는 Claude 운영

## 무엇이 들어 있나

- **규약** — 침묵하는 누락을 막는 3층: L1(기계 검사 — pre/postflight) · L2(보고서에 답이 있어야 하는 여섯 질문) ·
  L3(지휘자 규약 — 브리프·검증 배치·변이·모델 고르기·사용량 한도)
- **에이전트 정의** — 구현자 · 적대적 검증자(편집 도구 없음) · 탐색자(읽기 전용) · 테스트 실행자(실패 요약만)
- **도구** — `claude-ops`(동기화·검사) · `preflight.sh` · `postflight.sh` · `run-quiet.sh`(요약만 출력·종료 코드 보존) ·
  `usage-guard.py`(계정 사용량으로 동시성 판단 훅) · `tokens.py`(토큰 실측)
- **삽질 목록** — [`payload/.claude/ops/docs/LESSONS.md`](payload/.claude/ops/docs/LESSONS.md): 실제로 겪은 것만, 일반화해서
- **CI 예시** — [`ci/`](ci/): 같은 내용은 전체 테스트를 한 번만(내용 지문), 묶음 동시 실행

## 왜 이렇게 배포하나

클라우드 세션은 저장소의 플러그인·마켓플레이스 설정을 **설치하지 않는다**. 저장소에 **커밋된** `CLAUDE.md` ·
`.claude/{agents,skills,rules}` · 훅만 로드된다. 그래서 파일은 각 서비스 저장소에 실제로 들어가야 하고,
「복사하면 각자 고치기 시작한다」 는 문제는 lock + 검사 + 자동 동기화 PR 로 푼다(Dependabot 과 같은 모양).
비교표: [`docs/DESIGN.md`](docs/DESIGN.md).

```
 claude-ops-template (정본, 태그 vX.Y.Z)            서비스 저장소
 ├─ payload/                    ──── sync ────▶   ├─ .claude/ops/ …                 관리 파일
 │   ├─ .claude/ops/ …                            ├─ .claude/agents/ops-*.md          (check: 고치면 실패)
 │   ├─ .claude/agents/ops-*.md                   ├─ .claude/skills/ops-*/
 │   ├─ .claude/skills/ops-*/                     ├─ .claude/settings.json          생성물 = base + overlay
 │   └─ .claude/ops/settings.base.json            ├─ .claude/settings.overlay.json  ┐
 ├─ init/  오버레이 빈 틀 (init 이 한 번만)  ───▶  ├─ .claude/project.env           │ 오버레이
 ├─ ci/    CI 예시                                ├─ .claude/orchestrator.local.md  │ (sync 가 절대 안 씀)
 ├─ docs/  설계 · 도입 절차                        ├─ CLAUDE.md (서비스 지식)        ┘
 └─ test/  자체 시험                               ├─ .claude/ops.lock               출처·커밋·파일별 sha256
                                                  └─ .github/workflows/claude-ops-{check,sync}.yml
                                                       check: PR 마다 lock 대조 · sync: 주 1회 최신 태그 → PR
```

## 설치 (새 서비스)

단계별 절차(명령 그대로 복사): [`docs/ADOPT.md`](docs/ADOPT.md). 요약하면:

```bash
TEMPLATE_URL=https://github.com/<계정>/claude-ops-template.git
rm -rf /tmp/claude-ops-template && git clone --quiet --depth 1 "$TEMPLATE_URL" /tmp/claude-ops-template
node /tmp/claude-ops-template/bin/claude-ops.js init --source "$TEMPLATE_URL" --ref latest
# → .claude/project.env · CLAUDE.md 채우기 → check → 커밋
```

## 업데이트

- 서비스 쪽: 주 1회 자동 PR(`claude-ops-sync.yml`), 또는 `node .claude/ops/bin/claude-ops.js sync --ref latest`.
- 템플릿 쪽: 고치고 → `VERSION` · `CHANGELOG.md` → PR(`test` 워크플로 초록) → merge 커밋으로 머지 → main 에 태그 `vX.Y.Z`.

## 소비자에서 급하게 고쳐야 할 때

`.claude/ops.lock` 의 `overrides` 에 `{"path": "…", "reason": "…"}`. 사유가 없으면 받지 않고, 있는 동안 check 가 경고로 계속 알린다.
같은 변경을 템플릿에 올리고 받은 뒤 지운다. 자세히: [`docs/DESIGN.md`](docs/DESIGN.md) 3절.

## 템플릿 자체 시험

```bash
node test/run.js     # claude-ops sync/check/init · pre/postflight 판정(일부러 깨진 보고서로) · run-quiet · ci 부품
```

의존성 없음(Node 18+ · git · bash).

## 라이선스

정하지 않았다(소유자 결정 대기). 공개 저장소의 코드를 그대로 가져온 부분은 없다 — 공개 자료에서 얻은 것은 아이디어 수준이다
(예: 평가자 에이전트의 「편집 도구 없음 · 기본 판정 실패」 는 Anthropic 공개 예제의 방향과 같다).
