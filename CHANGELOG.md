# 변경 기록

형식: 버전마다 「무엇이 바뀌었나 / 소비자가 할 일」. 버전 규칙은 `docs/DESIGN.md` 5절.

## 1.0.0 — 첫 판

- 태그는 `.github/workflows/tag-release.yml` 이 붙인다 — VERSION 을 올린 PR 이 main 에 머지되면 `v<버전>` 태그·릴리즈가 생긴다(이미 있으면 건너뜀). 이 판(1.0.0)은 워크플로를 수동 실행해 붙인다.

여러 에이전트를 무인으로 돌려 실제 서비스를 만든 저장소의 규약·도구를, 서비스 이름 없이 공통부로 옮겼다.

- **`claude-ops` CLI**(의존성 없는 Node) — `init` · `sync`(템플릿을 git 으로 받아 payload 를 쓰고 `.claude/ops.lock` 갱신,
  오버레이는 고정 목록으로 거절) · `check`(lock 대조 — 소비자에서 관리 파일을 고치면 실패, `--deep` 은 템플릿 원본과 대조) ·
  `settings`(base + overlay → settings.json, 오프라인) · `status`. 탈출구 `overrides`(사유 필수).
- **규약 분리** — L1·L2 와 설계 원칙은 `.claude/ops/docs/CONVENTIONS.md`(모든 에이전트), L3·모델 고르기·사용량 한도는
  `.claude/skills/ops-orchestrator/SKILL.md`(자동 호출 꺼짐 — 지휘자만). 사고 사례는 일반화한 문장으로.
- **에이전트 정의** — `ops-implementer` · `ops-adversarial-verifier`(편집 도구 없음) · `ops-explorer`(읽기 전용, haiku) ·
  `ops-test-runner`(실패 요약만, haiku).
- **pre/postflight** — 값은 project.env. postflight 에 새 검사 둘: 보고서 맨 앞 `## 요약` 20줄 이내, `claude-ops check`.
  템플릿 이전 방식의 지문 검사 스크립트(`.claude/bin/conventions-hash.sh`)가 있으면 그것도 함께 돌린다.
- **브리프·보고서 틀** — CLAUDE.md 다시 읽지 않기 · 스크립트는 실행만 · 큰 에이전트는 다시 깨우지 말고 새 브리프로 ·
  테스트 출력은 파일로 · 로그는 에이전트별 고유 경로 · 남이 체크아웃한 브랜치 이름 쓰지 않기 · 요약 20줄.
- **`run-quiet.sh`** — 전체 로그는 실행마다 고유한 파일, 화면엔 요약·실패 블록, 종료 코드 보존.
- **`usage-guard.py` · `tokens.py`** — 사용량 한도 훅(SessionStart · SubagentStop), 토큰 집계(message.id 중복 제거).
- **settings.base.json** — 사용량 훅 둘.
- **`ci/` 예시** — 내용 지문으로 같은 내용은 한 번만 시험(`fingerprint.sh`), 묶음 러너(`run-shards.js`), 예시 워크플로.
- **`init/`** — 오버레이 빈 틀과 소비자 워크플로(`claude-ops-check.yml` · `claude-ops-sync.yml` — 공개 템플릿은 토큰 없이 받는다).
- 문서 — `README.md` · `docs/ADOPT.md`(붙이는 절차) · `docs/DESIGN.md`(판단 근거) · `.claude/ops/docs/LESSONS.md`(삽질 목록).
