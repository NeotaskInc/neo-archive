#!/usr/bin/env python3
import os, json, subprocess, time, pathlib, datetime, hashlib, statistics, platform, re, sys, zipfile, argparse, shutil, random
parser = argparse.ArgumentParser(description='Compare production Neo Archive and XF lexical search on a deterministic synthetic archive.')
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--size', type=int, choices=[10000, 100000], required=True)
parser.add_argument('--neo', default=shutil.which('neoarchive'))
parser.add_argument('--xf', default=shutil.which('xf'))
args = parser.parse_args()
if not args.neo or not args.xf:
    parser.error('Install neoarchive and xf, or pass their absolute paths.')
if platform.system() != 'Darwin':
    parser.error('This harness uses macOS /usr/bin/time -l for RSS.')
BASE = args.output.resolve()
BASE.mkdir(parents=True, exist_ok=True)
NEO = str(pathlib.Path(args.neo).resolve())
XF = str(pathlib.Path(args.xf).resolve())
if (BASE / str(args.size)).exists():
    parser.error('Use a new output directory; preserve previous evidence.')

def call(args, env=None):
    start = time.perf_counter_ns()
    p = subprocess.run(['/usr/bin/time', '-l', *args], capture_output=True, text=True, env=env)
    ms = (time.perf_counter_ns() - start) / 1000000.0
    rss = re.search('(\\d+)\\s+maximum resident set size', p.stderr)
    return {'ms': ms, 'rssBytes': int(rss[1]) if rss else None, 'code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}

def save(path, obj):
    path.write_text(json.dumps(obj, indent=2))

def corpus(n):
    base = BASE / str(n)
    data = base / 'archive' / 'data'
    data.mkdir(parents=True, exist_ok=True)
    terms = ['rust compiler ownership', 'typescript authentication oauth', 'sqlite database indexing', 'tantivy search ranking', 'agent tools orchestration', 'distributed cache consistency', 'browser automation playwright', 'bookmarks personal archive', 'memory retrieval embeddings', 'deployment rollback validation']
    tweets = []
    for i in range(n):
        text = terms[i % len(terms)] + ' ' + ['Building a local system with repeatable tests.', 'Comparing performance and correctness for this implementation.', 'Notes from debugging the production workflow.'][i % 3]
        if i % 997 == 0:
            text += ' rarequartz'
        if i % 223 == 0:
            text += ' café naïve 東京'
        if i % 317 == 0:
            text += ' rust-based C++ node.js'
        dt = datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(minutes=i)
        tweets.append({'tweet': {'id_str': str(1800000000000000000 + i), 'created_at': dt.strftime('%a %b %d %H:%M:%S +0000 %Y'), 'full_text': text, 'favorite_count': str(i % 100), 'retweet_count': '0', 'entities': {'hashtags': [], 'urls': [], 'user_mentions': []}}})
    account = [{'account': {'accountId': '91001', 'username': 'neo_benchmark', 'accountDisplayName': 'Synthetic Benchmark', 'createdAt': '2020-01-01T00:00:00.000Z'}}]
    for (name, value) in [('account', account), ('tweets', tweets)]:
        (data / (name + '.js')).write_text('window.YTD.' + name + '.part0 = ' + json.dumps(value, ensure_ascii=False))
    (data / 'manifest.js').write_text('window.__THAR_CONFIG = ' + json.dumps({'userInfo': {'accountId': '91001', 'userName': 'neo_benchmark', 'displayName': 'Synthetic Benchmark'}, 'archiveInfo': {'generationDate': '2026-09-07T00:00:00.000Z', 'isPartialArchive': False}}))
    with zipfile.ZipFile(base / 'archive.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for f in data.iterdir():
            z.write(f, 'archive/data/' + f.name)
    return base
n = args.size
base = corpus(n)
env = dict(os.environ, NEO_ARCHIVE_HOME=str(base / 'neo'), NEO_ARCHIVE_CONFIG=str(base / 'neo' / 'config.json'))
(base / 'neo').mkdir(exist_ok=True)
(base / 'neo' / 'config.json').write_text('{}')
xfbase = [XF, '--db', str(base / 'xf.sqlite'), '--index', str(base / 'xf-index'), '--format', 'json', '--quiet']
results = json.loads((base / 'imports.json').read_text()) if (base / 'imports.json').exists() else {}
if len(results) < 2 or any((x['code'] for x in results.values())):
    for (name, args) in [('neo', [NEO, '--json', 'import', 'archive', str(base / 'archive.zip'), '--account', 'neo_benchmark', '--select', 'tweets']), ('xf', xfbase + ['index', str(base / 'archive'), '--only', 'tweet', '--no-embeddings', '--jobs', '1'])]:
        if name in results and results[name]['code'] == 0:
            continue
        results[name] = call(args, env)
        save(base / 'imports.json', results)
        print(json.dumps({'phase': 'import', 'engine': name, 'n': n, 'code': results[name]['code'], 'ms': results[name]['ms']}), flush=True)
        if results[name]['code']:
            sys.exit(1)
save(base / 'identity.json', {'platform': platform.platform(), 'neo': NEO, 'xf': XF, 'neoVersion': call([NEO, '--version'])['stdout'], 'xfVersion': call([XF, '--version'])['stdout'], 'xfSha256': hashlib.sha256(pathlib.Path(XF).read_bytes()).hexdigest(), 'archiveSha256': hashlib.sha256((base / 'archive.zip').read_bytes()).hexdigest(), 'note': 'Fresh processes; OS page cache warm after one excluded pass. Import timings include different metadata pipelines. Match quality must be checked separately.'})
queries = ['rust', 'authentication', 'indexing', 'rarequartz', 'absentmanganese', 'rust compiler', '"local system"', 'café', '東京', 'node.js']
samples = []
for iteration in range(11):
    for q in queries:
        pair = {}
        engines = ['neo', 'xf'] if iteration % 2 == 0 else ['xf', 'neo']
        for engine in engines:
            args = [NEO, '--json', 'search', 'tweets', q, '--resource', 'authored', '--account', 'neo_benchmark', '--limit', '20'] if engine == 'neo' else xfbase + ['search', q, '--mode', 'lexical', '--types', 'tweet', '--sort', 'date-desc', '--limit', '20', '--no-daemon']
            r = call(args, env)
            if r['code']:
                save(base / 'failure.json', r)
                sys.exit(2)
            pair[engine] = r
        samples.append({'iteration': iteration, 'query': q, **pair})
    save(base / 'samples.json', samples)
    print(json.dumps({'phase': 'search', 'n': n, 'iteration': iteration}), flush=True)

def quantile(values, p):
    return sorted(values)[max(0, int(len(values) * p + 0.999999) - 1)]

def metrics(values):
    rng = random.Random(7301)
    boot = [statistics.median(rng.choices(values, k=len(values))) for _ in range(2000)]
    return {'medianMs': statistics.median(values), 'p95Ms': quantile(values, 0.95), 'median95CiMs': [quantile(boot, 0.025), quantile(boot, 0.975)]}
summary = {}
for engine in ['neo', 'xf']:
    vals = [s[engine]['ms'] for s in samples if s['iteration'] > 0]
    rss = [s[engine]['rssBytes'] for s in samples if s['iteration'] > 0]
    summary[engine] = {**metrics(vals), 'medianRssBytes': statistics.median(rss), 'perQuery': {q: metrics([s[engine]['ms'] for s in samples if s['iteration'] > 0 and s['query'] == q]) for q in queries}}
parity = {}
for sample in [s for s in samples if s['iteration'] == 1]:
    ids = {engine: [r['id'] for r in json.loads(sample[engine]['stdout'] or '[]')] for engine in ('neo', 'xf')}
    parity[sample['query']] = {**ids, 'sameOrderedIds': ids['neo'] == ids['xf']}
save(base / 'parity.json', parity)
save(base / 'summary.json', summary)
print(json.dumps(summary), flush=True)
