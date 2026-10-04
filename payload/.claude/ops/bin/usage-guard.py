#!/usr/bin/env python3
"""사용량 한도를 조회해 훅 JSON으로 내보낸다.

무인(non-stop) 작업 중 세션이 스스로 판단하도록, 에이전트가 끝나는 시점과
세션 시작 시점에 현재 한도 사용률을 모델 컨텍스트로 주입한다.

사용: usage-guard.py <hookEventName> [--force]

데이터 출처: https://api.anthropic.com/api/oauth/usage (문서화되지 않은 엔드포인트).
응답의 limits[] 배열이 완전한 형태이며 모델 한정 창(weekly_scoped)까지 담고 있다.
최상위 five_hour/seven_day 평면 필드는 모델 한정 창을 보여주지 않으므로 폴백으로만 쓴다.

주의:
- User-Agent: claude-code/ 헤더가 없으면 훨씬 좁은 버킷에 걸려 429가 난다.
- 권고 간격이 180초이므로 캐시로 강제한다.
- 어떤 실패에도 세션을 막지 않는다. 항상 exit 0.
"""
import json, os, subprocess, sys, time, datetime, pathlib

CACHE = pathlib.Path('/tmp/claude-usage-cache.json')
MIN_INTERVAL = 180
TIMEOUT = 20

# 판정 기준. 실측으로 보정한 값 — 서브에이전트 약 95만 토큰 시점에 주간 한도에 걸렸다.
STOP_AT = 95      # 이 이상이면 신규 에이전트 스폰 중지
SLOW_AT = 85      # 이 이상이면 동시 1개 + 경량 QA


def read_token():
    f = os.environ.get('CLAUDE_SESSION_INGRESS_TOKEN_FILE')
    if f and os.path.isfile(f):                      # 원격(클라우드) 세션
        return open(f).read().strip()
    cred = pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR') or
                        (pathlib.Path.home() / '.claude')) / '.credentials.json'
    if cred.is_file():                               # 로컬 세션
        try:
            return json.load(open(cred))['claudeAiOauth']['accessToken']
        except Exception:
            return None
    return None


def fetch(force):
    if not force and CACHE.is_file() and time.time() - CACHE.stat().st_mtime < MIN_INTERVAL:
        try:
            return json.load(open(CACHE)), 'cache'
        except Exception:
            pass
    token = read_token()
    if not token:
        return None, '토큰 없음'
    try:
        out = subprocess.run(
            ['curl', '-sS', '--max-time', str(TIMEOUT),
             'https://api.anthropic.com/api/oauth/usage',
             '-H', f'Authorization: Bearer {token}',
             '-H', 'anthropic-beta: oauth-2025-04-20',
             '-H', 'User-Agent: claude-code/',
             '-H', 'Content-Type: application/json'],
            capture_output=True, text=True, timeout=TIMEOUT + 5)
        data = json.loads(out.stdout)
        if not isinstance(data, dict) or ('limits' not in data and 'five_hour' not in data):
            return None, '응답 형식 불일치'
        CACHE.write_text(json.dumps(data))
        return data, 'api'
    except Exception as e:
        return None, type(e).__name__


def windows(data):
    """[(라벨, 퍼센트, 리셋ISO, 모델명 or None)] — limits[] 우선."""
    rows = []
    lim = data.get('limits')
    if isinstance(lim, list) and lim:
        for it in lim:
            model = ((it.get('scope') or {}).get('model') or {}).get('display_name')
            label = {'session': '5시간', 'weekly_all': '주간(전체)',
                     'weekly_scoped': f'주간({model})' if model else '주간(한정)',
                     'spend_limit': '지출'}.get(it.get('kind'), it.get('kind') or '?')
            rows.append((label, float(it.get('percent') or 0), it.get('resets_at'), model))
    else:
        for key, label in (('five_hour', '5시간'), ('seven_day', '주간(전체)')):
            v = data.get(key)
            if isinstance(v, dict) and v.get('utilization') is not None:
                rows.append((label, float(v['utilization']), v.get('resets_at'), None))
    return rows


def kst(iso):
    if not iso:
        return '-'
    try:
        t = datetime.datetime.fromisoformat(iso.replace('Z', '+00:00'))
    except Exception:
        return '-'
    k = t.astimezone(datetime.timezone(datetime.timedelta(hours=9)))
    mins = max(0, int((t - datetime.datetime.now(datetime.timezone.utc)).total_seconds() // 60))
    return f"{k:%m-%d %H:%M}KST/{mins // 60}h{mins % 60:02d}m"


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else 'SessionStart'
    force = '--force' in sys.argv
    data, src = fetch(force)

    if data is None:
        # 조회 실패는 조용히 넘긴다. 판단 근거가 없다는 사실만 알린다.
        emit({'suppressOutput': True, 'hookSpecificOutput': {
            'hookEventName': event,
            'additionalContext': f'[사용량] 조회 불가({src}) — 한도 수치 없이 진행. '
                                 '보수적으로 동시 에이전트 1개로 제한하고, 429가 나면 즉시 중지·재예약할 것.'}})

    rows = windows(data)
    if not rows:
        emit({'suppressOutput': True})

    rows.sort(key=lambda r: -r[1])
    summary = ' · '.join(f'{l} {p:.0f}%' for l, p, _, _ in rows)

    # 전역 판정은 모델 한정이 아닌 창(5시간·주간 전체·지출)으로만 낸다.
    # 모델 한정 창이 꽉 차도 다른 모델로는 계속 작업할 수 있기 때문이다.
    glob = [r for r in rows if not r[3]] or rows
    worst_label, worst_pct, worst_reset, _ = glob[0]
    blocked = sorted({m for _, p, _, m in rows if m and p >= STOP_AT})
    tight = sorted({m for _, p, _, m in rows if m and SLOW_AT <= p < STOP_AT})

    if worst_pct >= STOP_AT:
        verdict = (f'중지 — {worst_label} {worst_pct:.0f}%. 신규 에이전트를 띄우지 말고, '
                   f'진행 중 작업만 마무리(머지 포함)한 뒤 {kst(worst_reset)} 이후로 '
                   'send_later 재개 예약하고 대기.')
        sev = 'critical'
    elif worst_pct >= SLOW_AT:
        verdict = (f'감속 — {worst_label} {worst_pct:.0f}%. 동시 에이전트 1개로 줄이고 '
                   f'QA는 경량(캡처 최소·계측 위주)으로. 리셋 {kst(worst_reset)}.')
        sev = 'warning'
    else:
        verdict = f'계속 — 여유 있음(최고 {worst_label} {worst_pct:.0f}%). 동시 에이전트 최대 2개.'
        sev = 'normal'

    notice = None
    if sev == 'critical':
        notice = f'{worst_label} {worst_pct:.0f}% — 신규 에이전트 중지'
    elif sev == 'warning':
        notice = f'{worst_label} {worst_pct:.0f}% — 감속 권고'
    if blocked:
        verdict += (f' / 사용 금지 모델: {", ".join(blocked)} (한정 한도 초과) — '
                    'Agent 도구의 model 인자로 다른 모델을 지정할 것.')
        if sev == 'normal':
            sev = 'warning'
            notice = f'{", ".join(blocked)} 한도 초과 — 다른 모델로 작업'
    if tight:
        verdict += f' / 한도 임박 모델: {", ".join(tight)} — 가능하면 다른 모델로.'

    lines = [f'[사용량 {src}] ' + summary,
             '  ' + ' | '.join(f'{l} 리셋 {kst(r)}' for l, _, r, _ in rows),
             f'  판정: {verdict}']
    payload = {'suppressOutput': True, 'hookSpecificOutput': {
        'hookEventName': event, 'additionalContext': '\n'.join(lines)}}
    if notice:
        payload['systemMessage'] = '사용량 ' + notice
    emit(payload)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(0)   # 훅이 세션을 막지 않는다
