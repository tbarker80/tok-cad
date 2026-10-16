"""TOK CAD at /cad behind a proxy: no request leaves /cad/, no errors, signup works, cookie
scoped to /cad, a STEP imports and exports."""
import os, sys, time, secrets
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8099/cad/'
STEP = r'E:\test files\knurl\Part1.STEP'
ok = True
def check(c, m):
    global ok
    print(('PASS ' if c else 'FAIL ') + m); ok = ok and c
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(accept_downloads=True, viewport={'width': 1400, 'height': 850})
    pg = ctx.new_page()
    reqs, errs = [], []
    pg.on('request', lambda r: reqs.append(r.url))
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.on('response', lambda r: errs.append(f'HTTP {r.status} {r.url}') if r.status >= 400 else None)
    pg.on('console', lambda m: errs.append('console: ' + m.text[:200]) if m.type == 'error' else None)
    pg.goto(BASE, wait_until='networkidle', timeout=90000)
    pg.wait_for_timeout(4000)
    host = urlparse(BASE).netloc
    outside = [u for u in reqs if urlparse(u).scheme in ('http', 'https') and (urlparse(u).netloc != host or not urlparse(u).path.startswith('/cad/'))]
    check(not outside, f'studio: {len(reqs)} requests, none outside /cad/ {outside[:5]}')
    check(not errs, f'studio: no page/console errors {errs[:5]}')
    # import a STEP and export it again
    pg.set_input_files('#bw-open-file', STEP)
    pg.wait_for_timeout(20000)
    with pg.expect_download(timeout=120000) as dl:
        pg.evaluate("() => document.getElementById('bw-export-step').click()")
    path = dl.value.path()
    size = os.path.getsize(path)
    head = open(path, 'rb').read(64)
    check(size > 10000 and b'ISO-10303-21' in head, f'STEP import -> export round trip ({dl.value.suggested_filename}, {size} bytes)')
    # account page: sign up, session cookie scoped to /cad
    pg.goto(BASE + 'account', wait_until='networkidle')
    name = 'tok' + secrets.token_hex(4)
    pg.fill('#pm-signup-form input[name=name]', name)
    pg.fill('#pm-signup-form input[name=password]', 'correct horse battery staple')
    pg.click('#pm-signup-form button[type=submit]')
    pg.wait_for_timeout(3000)
    cookies = [c for c in ctx.cookies() if 'account' in c['name']]
    check(len(cookies) == 1 and cookies[0]['path'] == '/cad', f'signed up; session cookie {[(c["name"], c["path"]) for c in cookies]}')
    me = pg.evaluate("async () => (await fetch('/cad/api/v1/account', {credentials: 'same-origin'})).status")
    check(me == 200, f'session works for /cad/api/v1/account ({me})')
    pg.goto(BASE.rstrip('/').rsplit('/cad', 1)[0] + '/', wait_until='load')
    sent = pg.evaluate("() => document.cookie")
    check('account' not in sent, 'session cookie not visible outside /cad')
    check(not [e for e in errs if 'favicon' not in e], f'no errors overall {errs[:5]}')
    b.close()
print('ALL PASSED' if ok else 'FAILED')
