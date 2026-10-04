# <서비스 이름> — 세션 작업 지침

<한 줄: 이 서비스가 무엇인가.>

## 에이전트 작업 규약

공통 규약은 템플릿(claude-ops)에서 온다 — `.claude/ops.lock` 이 버전을 고정한다. 관리 파일은 여기서 고치지 않는다.

```bash
bash .claude/ops/bin/preflight.sh    # 시작 전 — 읽지 말고 실행만
bash .claude/ops/bin/postflight.sh   # 끝낸 뒤 — 보고서(맨 앞 요약 20줄)·L2 답변·트레일러·관리 파일
```

- 작업 에이전트: `.claude/ops/docs/CONVENTIONS.md`(L1·L2). 보고서 틀 `.claude/ops/templates/report.md`.
- **세션을 지휘한다면**(에이전트를 띄운다면) 먼저 `.claude/skills/ops-orchestrator/SKILL.md` 와
  `.claude/orchestrator.local.md` 를 읽는다(사람은 `/ops-orchestrator`).
- 프로젝트별 값은 `.claude/project.env`, 이 저장소만의 Claude Code 설정은 `.claude/settings.overlay.json`.

## 구조

| 경로 | 역할 |
|---|---|
| | |

## 불변식

<!-- 「빼면 에이전트가 실수하는가」 로 거른 규칙만. 규칙 한 문장 + 근거 이슈 번호. -->

검증: <VERIFY_CMD 와 같은 명령 · 실행 확인 방법>
