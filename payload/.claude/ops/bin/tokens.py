#!/usr/bin/env python3
"""로컬 JSONL 로그에서 모델별 토큰을 집계한다. 네트워크 불필요.
이 기기(컨테이너)의 로그만 보므로 플랜 한도 %가 아니라 '토큰 실측'이다.
사용법: tokens.py [프로젝트디렉터리] [--by-agent] [--since YYYY-MM-DD] [--json]

중복 제거(2026-10-04 감사): Claude Code 는 응답 하나를 내용 블록마다 여러 줄로 쓰고
같은 message.id·같은 usage 를 줄마다 반복한다. 예전 집계는 줄마다 더해 캐시 쓰기를 약 2배,
출력을 약 1.4배로 셌다. 이제 message.id 하나를 요청 하나로 센다(출력은 같은 id 중 최대값,
나머지 칸은 마지막 줄 값).

'입력환산' 은 API 단가 비율로 묶은 한 숫자다(입력 1 · 캐시 읽기 0.1 · 5분 캐시 쓰기 1.25 ·
1시간 캐시 쓰기 2.0 · 출력 5). 플랜 한도 산식은 공개되지 않았으므로 **비교용 추정**이다 —
바꾸기 전후를 같은 잣대로 재는 데 쓴다. 캐시 쓰기의 5분/1시간 구분은 usage.cache_creation 이
있을 때만 나뉘고, 없으면 5분으로 본다."""
import json, glob, os, sys, collections

W = {'input': 1.0, 'cache_read': 0.1, 'cw_5m': 1.25, 'cw_1h': 2.0, 'output': 5.0}

args = sys.argv[1:]
by_agent = '--by-agent' in args
if by_agent: args.remove('--by-agent')
as_json = '--json' in args
if as_json: args.remove('--json')
since = None
if '--since' in args:
    i = args.index('--since'); since = args[i+1]; del args[i:i+2]
root = args[0] if args else os.path.expanduser('~/.claude/projects')

files = sorted(glob.glob(os.path.join(root, '**', '*.jsonl'), recursive=True))


def read_usage(u):
    """usage 한 덩어리 → 칸별 정수. cache_creation 세부가 없으면 전부 5분으로."""
    g = lambda k: u.get(k) if isinstance(u.get(k), int) else 0
    cw = g('cache_creation_input_tokens')
    det = u.get('cache_creation') if isinstance(u.get('cache_creation'), dict) else {}
    cw_1h = det.get('ephemeral_1h_input_tokens') if isinstance(det.get('ephemeral_1h_input_tokens'), int) else 0
    cw_5m = det.get('ephemeral_5m_input_tokens') if isinstance(det.get('ephemeral_5m_input_tokens'), int) else cw - cw_1h
    return {'input': g('input_tokens'), 'output': g('output_tokens'), 'cache_read': g('cache_read_input_tokens'),
            'cw_5m': max(cw_5m, 0), 'cw_1h': max(cw_1h, 0)}


by_model = collections.defaultdict(collections.Counter)
by_file = collections.defaultdict(collections.Counter)
raw_lines = 0

for f in files:
    name = os.path.basename(f).replace('.jsonl', '')
    msgs = {}   # message.id → (model, usage 칸)
    anon = 0
    for line in open(f, encoding='utf-8', errors='replace'):
        try: o = json.loads(line)
        except Exception: continue
        if since and (o.get('timestamp') or '')[:10] < since: continue
        m = o.get('message')
        if not isinstance(m, dict): continue
        u = m.get('usage')
        if not isinstance(u, dict): continue
        model = m.get('model') or 'unknown'
        if model == '<synthetic>': continue
        raw_lines += 1
        cur = read_usage(u)
        mid = m.get('id')
        if not mid:                        # id 가 없는 옛 줄은 줄 하나를 요청 하나로
            anon += 1; mid = f'__anon{anon}'
        prev = msgs.get(mid)
        if prev:
            cur['output'] = max(cur['output'], prev[1]['output'])
        msgs[mid] = (model, cur)
    for model, c in msgs.values():
        for agg in (by_model[model], by_file[name]):
            agg['요청'] += 1
            agg.update(c)


def weighted(c):
    return sum(c[k] * w for k, w in W.items())


def table(d, head):
    if not d: print('데이터 없음'); return
    w = max(len(k) for k in d) + 1
    cols = f"{'요청':>7}{'입력':>10}{'출력':>12}{'캐시쓰기5m':>14}{'캐시쓰기1h':>14}{'캐시읽기':>16}{'입력환산':>14}"
    print(f"{head:<{w}}{cols}")
    tot = collections.Counter()
    def row(k, c):
        print(f"{k:<{w}}{c['요청']:>7,}{c['input']:>10,}{c['output']:>12,}{c['cw_5m']:>14,}{c['cw_1h']:>14,}"
              f"{c['cache_read']:>16,}{round(weighted(c)):>14,}")
    for k, c in sorted(d.items(), key=lambda kv: -weighted(kv[1])):
        row(k, c); tot.update(c)
    print('-' * (w + 87))
    row('합계', tot)


if as_json:
    out = {'files': len(files), 'raw_usage_lines': raw_lines, 'weights': W,
           'by_model': {k: dict(v, weighted=round(weighted(v))) for k, v in by_model.items()}}
    if by_agent:
        out['by_agent'] = {k: dict(v, weighted=round(weighted(v))) for k, v in by_file.items()}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(0)

reqs = sum(c['요청'] for c in by_model.values())
print(f"로그 {len(files)}개 파일" + (f" · {since} 이후" if since else "") +
      f" · usage 줄 {raw_lines:,} → 고유 요청 {reqs:,}")
print("입력환산 = 입력 1 · 캐시읽기 0.1 · 캐시쓰기 5m 1.25 · 1h 2.0 · 출력 5 (비교용 추정, 플랜 한도 산식 아님)")
table(by_model, '모델')
if by_agent:
    print(); table(by_file, '세션/에이전트')
