# 설계 판단

이 템플릿을 왜 이 모양으로 만들었는지 — 다음에 바꾸려는 사람이 같은 비교를 다시 하지 않도록 남긴다.

## 1. 배포 방식 비교

요구: (1) 클라우드 세션에서 에이전트 정의·규칙·skill·훅이 **로드돼야** 하고 (2) 템플릿을 고치면 모든 서비스가 **같게** 동작해야 하며
(중앙관리) (3) 오프라인·네트워크 장애에서도 작업이 막히지 않고 (4) 서비스 코드에 위험이 없어야 한다.

결정 요인: 클라우드 세션은 저장소의 `enabledPlugins`·`extraKnownMarketplaces` 를 **설치하지 않는다**. 저장소에 **커밋된**
`CLAUDE.md` · `.claude/{agents,skills,rules,commands}` · `.claude/settings.json` 훅만 로드된다(공식 문서 — cloud-environments · settings).
그래서 「소비자 저장소에 실제 파일이 커밋돼 있는가」 가 첫 관문이다.

| 방식 | 클라우드 세션 로딩 | 중앙관리 | 오프라인 | 위험·비용 | 판정 |
|---|---|---|---|---|---|
| **버전 고정 파일 + lock + 동기화 PR** (이 템플릿) | ● 파일이 커밋돼 있다 | ● 정본 한 곳, check 가 표류를 실패로, 동기화 PR(수동 실행 — 주기는 선택) | ● check 는 lock 만 본다(오프라인). sync 만 네트워크 | 낮음 — 관리 구역 밖은 쓰지 않음, PR 로 사람이 머지 | **채택** |
| 플러그인·마켓플레이스 | ○ 설치 안 됨 | ● | — | 낮음 | 클라우드에서 안 돈다 |
| npm(GitHub) 의존성 + postinstall 복사 | ◐ 설치·복사 후 커밋해야 로드 | ◐ 버전 고정은 되나 복사본 표류 검사 없음 | ○ 설치에 네트워크 | 중간 — 비 Node 서비스엔 부적합, postinstall 은 임의 코드 실행 | 기각 |
| git submodule | ◐ 세션이 서브모듈을 초기화하는지에 달림, `.claude/agents` 가 서브모듈 안이면 경로가 안 맞음 | ● 커밋 고정 | ○ 초기화에 네트워크·권한 | 중간 — 세션마다 초기화·권한 문제(이전에 기각한 이력) | 기각 |
| git subtree | ● 파일이 커밋된다 | ◐ 당겨오기는 되나 소비자 수정을 막는 장치 없음, 경로가 한 디렉터리로 묶임(`.claude/agents` 와 `.claude/ops` 를 동시에 못 씀) | ● | 중간 — 이력이 섞이고 실수로 push 하면 템플릿을 오염 | 기각(lock·check 를 따로 만들어야 해서 이 방식과 같아짐) |
| 템플릿의 reusable workflow(`workflow_call`) | ○ CI 에만 해당 — 에이전트 정의·규칙은 못 옮김 | ● CI 만 | — | 낮음 | CI 부품을 나중에 이렇게 바꿀 수는 있다(`ci/` 참고) |
| 그냥 복사 + 지문 대조(이전 방식) | ● | ○ 저장소마다 동시 PR, 사례 덧붙이기 허용 후 표류가 diff 잡음에 숨음(실측) | ● | 낮음 | 대체됨 |

## 2. 무엇이 공통이고 무엇이 오버레이인가

| 구분 | 경로 | 주인 | sync 가 | check 가 |
|---|---|---|---|---|
| 관리 파일 | `.claude/ops/**`(bin · templates · docs · settings.base.json) · `.claude/agents/ops-*` · `.claude/skills/ops-*` | 템플릿 | 쓰고 지운다 | lock 과 다르면 실패 |
| 생성물 | `.claude/settings.json` = base + overlay | 템플릿 + 소비자 | 다시 만든다 | 병합 결과와 다르면 실패 |
| 오버레이 | `CLAUDE.md` · `.claude/project.env` · `.claude/settings.overlay.json` · `.claude/orchestrator.local.md` · `.claude/rules/**` · `.claude/reports/**` | 소비자 | **절대 쓰지 않는다**(고정 목록으로 거절) | 보지 않는다 |
| 소비자 소유 워크플로 | `.github/workflows/claude-ops-check.yml` · `claude-ops-sync.yml` | 소비자(`init` 이 한 번 만듦) | 쓰지 않는다 | 보지 않는다 |
| 서비스 전용 에이전트·skill | `.claude/agents/<ops- 가 아닌 이름>` · `.claude/skills/<ops- 가 아닌 이름>` | 소비자 | 쓰지 않는다 | 보지 않는다 |
| 템플릿에만 | `docs/` · `ci/`(예시) · `test/` · `init/`(빈 틀) · `bin/` | 템플릿 | 들어가지 않는다 | — |

경계 판단:

- **무엇이 공통인가** — 「서비스 이름·경로·도메인 없이 쓸 수 있는가」. 규약 L1·L2·L3, 브리프·보고서 틀, pre/postflight(값은 project.env),
  사용량 훅(계정 단위), 토큰 집계, 출력 요약 실행기, 역할별 에이전트 정의.
- **워크플로를 payload 에 넣지 않은 이유** — GITHUB_TOKEN 은 워크플로 파일을 바꾸는 푸시를 못 하고, 그 PR 은 다른 워크플로를 깨우지 않는다.
  자동 동기화가 자기 자신을 갱신하려다 실패하는 모양을 피했다.
- **CI 부품(`ci/`)을 payload 에 넣지 않은 이유** — CI 는 서비스마다 런타임·설치가 달라 「그대로 동작」 을 보장할 수 없다. 예시로 둔다.
- **허용 구역·금지 경로는 manifest 가 아니라 CLI 안에 고정** — sync 를 실행하는 것은 소비자가 이미 가진 CLI 라, 받아 온 템플릿이 목록을 넓혀
  `CLAUDE.md` 를 덮을 수 없다(시험: `test/claude-ops.test.js` 「금지 경로」).

## 3. 소비자에서 급하게 관리 파일을 고쳐야 할 때 (탈출구)

`.claude/ops.lock` 의 `overrides`:

```json
"overrides": [
  { "path": ".claude/ops/bin/postflight.sh", "reason": "mawk 오탐 — 템플릿 PR 대기, 머지되면 sync 로 지운다" }
]
```

- `reason` 이 비면 check 실패(사유 없는 탈출구는 받지 않는다 — 규약의 「거부권은 이유를 적고」 와 같은 원리).
- 있는 동안 check 는 **경고**로 계속 알리고(통과), sync 는 그 파일을 덮지 않고 경고한다.
- 관리 파일이 아닌 경로를 적으면 실패. 템플릿 판과 같아졌으면 「지워도 된다」 경고.
- 끝은 늘 같다: **같은 변경을 템플릿에 올리고, 받은 뒤 override 를 지운다.**

## 4. 받아들인 한계

- 얕은 `check` 는 lock 만 본다 — lock 과 파일을 **함께** 손으로 고치면 통과한다. `check --deep` 이 템플릿 원본(잠근 커밋)과 대조해 잡는다
  (네트워크 필요 — 소비자 CI 의 보조 단계, 막지 않음). 의도적인 우회까지 막지는 않는다.
- `claude-ops check` 는 node 가 필요하다. postflight 는 node 가 없으면 경고만 하고 CI 가 잡는다(작업을 막지 않는다).
- sync 는 git 이 필요하다(템플릿을 git 으로 받는다). 공개 템플릿은 익명, 비공개면 `CLAUDE_OPS_TOKEN`(http.extraHeader — URL 에 넣지 않음).

## 5. 버전 규칙

- `VERSION` 과 태그 `vX.Y.Z` 는 같아야 한다. 소비자의 동기화(`--ref latest`)는 **가장 높은 vX.Y.Z 태그**를 받는다(숫자 순서).
- **major** — 소비자가 손을 대야 하는 변경(오버레이 변수 이름·경로 이동·요구문의 의미 변경). CHANGELOG 에 옮기는 법.
- **minor** — 새 관리 파일·새 검사(기존 보고서·설정이 그대로 통과해야 한다).
- **patch** — 문구·버그 수정.
- 태그는 템플릿 PR 이 머지된 뒤 main 에 붙인다. 머지는 merge 커밋으로(squash 하면 브랜치 커밋이 사라져 그 커밋을 잠근 소비자의 `--deep` 이 실패한다).
