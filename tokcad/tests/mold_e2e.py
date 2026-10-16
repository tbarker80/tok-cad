"""TOK CAD molding check, end to end: browser -> TOK CAD server -> molding service and back.

Needs the branded /cad build behind the test nginx, a dev outbox in <state>/mail.json, and
<state>/mold.json pointing at a running molding service (CAD EVAL's dev server) with its secret.
The fixtures are STEP files from that service's own tests (a box with vertical walls, and a
housing with side holes that need slides).

Run: python tokcad/tests/mold_e2e.py http://127.0.0.1:8099/cad/ OUTBOX_DIR FIXTURE_DIR [screenshot dir]
"""
import glob
import json
import os
import re
import secrets
import sys
import time

from playwright.sync_api import sync_playwright

BASE, OUTBOX, FIXTURES = sys.argv[1], sys.argv[2], sys.argv[3]
SHOTS = sys.argv[4] if len(sys.argv) > 4 else None
PASSWORD = 'correct horse battery staple'
ok = True


def check(cond, msg):
    global ok
    print(('PASS ' if cond else 'FAIL ') + msg)
    ok = ok and cond


def wait_mail(addr, since, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        for f in sorted(glob.glob(os.path.join(OUTBOX, '*.json'))):
            if os.path.getmtime(f) >= since:
                m = json.load(open(f, encoding='utf-8'))
                if m['to'] == addr and 'Confirm' in m['subject']:
                    return m
        time.sleep(0.2)
    return None


def api(pg, path, body):
    return pg.evaluate("""async ([path, body]) => {
        const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'},
                                     body: JSON.stringify(body), credentials: 'same-origin'});
        return [r.status, await r.json().catch(() => ({}))];
    }""", [BASE + path, body])


def new_context(browser):
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    ctx.add_cookies([{'name': 'partmode_cookie_consent', 'value': 'essential-v1', 'url': BASE}])
    ctx.add_init_script("try { localStorage.setItem('tokcad-mode', 'beginner'); } catch (e) {}")
    return ctx


def open_part(pg, name):
    before = pg.evaluate('() => globalThis.TokcadStudio.contentHash()')
    pg.set_input_files('#bw-open-file', os.path.join(FIXTURES, name))
    pg.wait_for_function(f'() => globalThis.TokcadStudio.contentHash() !== {json.dumps(before)} && globalThis.TokcadStudio.bodyMeshes().size > 0',
                         timeout=120000)
    pg.wait_for_timeout(2000)
    while pg.is_visible('.tokcad-start'):
        pg.keyboard.press('Escape')
        pg.wait_for_timeout(300)


def run_check(pg, timeout=180000):
    pg.evaluate('() => globalThis.TokcadMold.run()')
    pg.wait_for_function('() => !globalThis.TokcadMold.state().busy', timeout=timeout)
    return pg.evaluate("""() => { const s = globalThis.TokcadMold.state();
        return { error: s.error, message: s.message, undercut: s.result?.undercut, pull: s.result?.pull,
                 wall: s.result?.wall }; }""")


def bounds(pg):
    """World bounding boxes of the studio's part and of the molding overlay, side by side."""
    return pg.evaluate("""() => {
        const { THREE, partGroup } = globalThis.TokcadStudio.scene();
        const overlay = partGroup.getObjectByName('tokcad-mold-overlay');
        if (!overlay) return null;
        partGroup.updateMatrixWorld(true);
        const part = new THREE.Box3();
        for (const m of globalThis.TokcadStudio.bodyMeshes().values()) {
            const objects = Array.isArray(m) ? m : [m];
            for (const o of objects) if (o?.isObject3D) part.expandByObject(o);
        }
        const mold = new THREE.Box3();
        overlay.traverse((o) => { if (o.isMesh && o.userData.tokcadMold) mold.expandByObject(o); });
        return { part: [part.min.toArray(), part.max.toArray()], mold: [mold.min.toArray(), mold.max.toArray()] };
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
    errors = []

    # ── signed out: the check asks for an account; the API refuses ───────────────────────
    ctx = new_context(browser)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
    pg.goto(BASE, wait_until='networkidle', timeout=90000)
    pg.wait_for_function('() => globalThis.TokcadMold && globalThis.TokcadStudio', timeout=60000)
    open_part(pg, 'box_test.step')
    r = run_check(pg)
    check(r['error'] and r['message'] == 'signin', f'signed out: the check asks for an account ({r["message"]})')
    check(pg.is_visible('#tokcad-mold a[href$="/account"]'), 'signed out: the panel links to the account page')
    code = pg.evaluate("""async (base) => (await fetch(base + 'api/v1/mold/sessions', {method: 'POST',
        headers: {'content-type': 'application/octet-stream'}, body: 'ISO-10303-21;'})).status""", BASE)
    check(code == 401, f'signed out: the upload API answers 401 ({code})')
    ctx.close()

    # ── a verified account ────────────────────────────────────────────────────────────────
    ctx = new_context(browser)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
    name = 'mold' + secrets.token_hex(3)
    email = f'{name}@example.com'
    t0 = time.time() - 1
    pg.goto(BASE + 'account', wait_until='networkidle')
    code, _ = api(pg, 'api/v1/accounts', {'name': name, 'email': email, 'password': PASSWORD})
    mail = wait_mail(email, t0)
    check(code in (200, 201) and mail is not None, f'signed up {name}, confirmation mail sent ({code})')
    pg.goto(re.search(r'https?://\S+', mail['text']).group(0), wait_until='networkidle')

    pg.goto(BASE, wait_until='load', timeout=90000)       # signed in, the studio keeps a poll open
    pg.wait_for_function('() => globalThis.TokcadMold && globalThis.TokcadStudio', timeout=60000)

    # wrong CSRF token is refused even when signed in
    code = pg.evaluate("""async (base) => (await fetch(base + 'api/v1/mold/sessions', {method: 'POST',
        headers: {'content-type': 'application/octet-stream', 'x-partmode-csrf': 'nope'}, body: 'ISO-10303-21;'})).status""", BASE)
    check(code == 403, f'a wrong security token is refused ({code})')

    # ── the box: vertical walls, so no draft; no undercuts ───────────────────────────────
    open_part(pg, 'box_test.step')
    t = time.time()
    r = run_check(pg)
    check(not r['error'], f'box: check ran in {time.time() - t:.1f}s ({r["message"] or "ok"})')
    if not r['error']:
        check(r['undercut']['regions'] == 0, f'box: no undercuts ({r["undercut"]["regions"]})')
        f = pg.evaluate('() => globalThis.TokcadMold.findings()')
        check(len(f['noDraft']) >= 4, f'box: its {len(f["noDraft"])} vertical walls are flagged as having no draft')
        bb = bounds(pg)
        if bb:
            span = max(bb['part'][1][i] - bb['part'][0][i] for i in range(3)) or 1
            off = max(abs(bb['part'][k][i] - bb['mold'][k][i]) for k in range(2) for i in range(3))
            check(off < span * 0.005, f'box: the overlay sits exactly on the part (off by {off:.4f} of {span:.1f})')
        else:
            check(False, 'box: an overlay is drawn')
        check('No draft' in pg.inner_text('#tokcad-mold .tokcad-legend'), 'box: the draft legend is shown')
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, 'mold_box_draft.png'))
        pg.click('#tokcad-mold .tokcad-finding button:has-text("Show me")')
        check(pg.evaluate('() => globalThis.TokcadMold.state().highlight !== null'), 'box: "Show me" highlights a face')
        for view in ('thickness', 'undercut', 'halves'):
            pg.click(f'#tokcad-mold [data-mold-view="{view}"]')
            check(pg.is_visible(f'#tokcad-mold [data-mold-view="{view}"].is-on'), f'box: the {view} view opens')
        check('7 days' in pg.inner_text('#tokcad-mold'), 'the panel says parts are kept for 7 days')
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, 'mold_box_halves.png'))
        # a forced pull direction is sent and used
        pg.select_option('#tokcad-mold select', '+x')
        r2 = run_check(pg)
        check(not r2['error'] and r2['pull']['vector'] == [1, 0, 0] and not r2['pull']['inferred'],
              f'box: a chosen opening direction is used ({r2["pull"]})')
        pg.select_option('#tokcad-mold select', 'auto')

    # ── the housing: side holes that need slides. It has three solids and the side features
    #    are on two of them, so this also checks that every body is sent, not just one ──────
    open_part(pg, 'housing_cap.step')
    check(pg.evaluate("() => !globalThis.TokcadStudio.scene().partGroup.getObjectByName('tokcad-mold-overlay')"),
          'a new part clears the old overlay')
    r = run_check(pg)
    check(not r['error'], f'housing: check ran ({r["message"] or "ok"})')
    if not r['error']:
        u = r['undercut']
        check((u['regions'], u['slides'], u['lifters']) == (8, 4, 0),
              f'housing: 8 undercuts, 4 slides, as CAD EVAL finds ({u["regions"]}, {u["slides"]}, {u["lifters"]})')
        pg.click('#tokcad-mold [data-mold-view="undercut"]')
        arrows = pg.evaluate("""() => { let n = 0; globalThis.TokcadStudio.scene().partGroup.getObjectByName('tokcad-mold-overlay')
            .traverse((o) => { if (o.type === 'ArrowHelper') n++; }); return n; }""")
        expected = sum(len(g['centroids']) for g in u['groups'])
        check(arrows == expected and arrows > 0, f'housing: an arrow per undercut region ({arrows} of {expected})')
        check('4 slides' in pg.inner_text('#tokcad-mold'), 'housing: the panel says it needs 4 slides')
        if SHOTS:
            pg.screenshot(path=os.path.join(SHOTS, 'mold_housing_undercut.png'))

    # ── "Fix it: add draft" on parts modeled here ─────────────────────────────────────────
    def new_shape(label):
        pg.click('#tokcad-start-open')
        pg.wait_for_selector('.tokcad-start', timeout=30000)
        pg.click('text=Start from scratch')
        pg.click(f'.tokcad-shape:has-text("{label}")')
        before = pg.evaluate('() => globalThis.TokcadStudio.contentHash()')
        pg.click('.tokcad-form button[type=submit]')
        pg.wait_for_function('h => globalThis.TokcadStudio.contentHash() !== h && globalThis.TokcadStudio.bodyMeshes().size > 0'
                             ' && !globalThis.TokcadStudio.building()', arg=before, timeout=90000)
        pg.wait_for_timeout(1000)

    def fix_draft():
        pg.click('#tokcad-mold [data-mold-view="draft"]')
        pg.click('#tokcad-mold [data-mold-fix="draft"]')
        pg.wait_for_function('() => !globalThis.TokcadMold.state().busy && /^Added|could not/.test(globalThis.TokcadMold.state().message)',
                             timeout=180000)
        return pg.evaluate('() => globalThis.TokcadMold.state().message')

    def features():
        return [f['name'] for f in pg.evaluate('() => globalThis.TokcadStudio.document().partDefinitions[0].features')]

    check(not pg.is_visible('#tokcad-mold [data-mold-fix]'), 'no "Fix it" button for an imported part (it opens as an assembly)')
    new_shape('Block')
    r = run_check(pg)
    f = pg.evaluate('() => globalThis.TokcadMold.findings()')
    check(not r['error'] and len(f['noDraft']) == 4, f'block: its 4 side walls have no draft ({len(f["noDraft"])})')
    msg = fix_draft()
    f = pg.evaluate('() => globalThis.TokcadMold.findings()')
    check(msg.startswith('Added') and 'Draft for molding' in features(), f'block: "Fix it" adds a Draft feature ({features()})')
    check(len(f['noDraft']) == 0 and len(f['lowDraft']) == 0, f'block: after the fix no face lacks draft ({len(f["noDraft"])}, {len(f["lowDraft"])})')
    if SHOTS:
        pg.screenshot(path=os.path.join(SHOTS, 'mold_block_fixed.png'))
    pg.keyboard.press('Control+z')
    pg.wait_for_function('() => !globalThis.TokcadStudio.document().partDefinitions[0].features.some((f) => f.type === "draft")', timeout=30000)
    check(True, 'block: the fix undoes like any other change')

    new_shape('Plate with holes')
    run_check(pg)
    f = pg.evaluate('() => globalThis.TokcadMold.findings()')
    msg = fix_draft()
    check(msg.startswith('Added') and 'round face' in msg and 'Loft' in msg,
          f'plate: flat walls drafted, the round holes explained ({msg[:120]})')
    f2 = pg.evaluate('() => globalThis.TokcadMold.findings()')
    check(len(f2['noDraft']) < len(f['noDraft']), f'plate: fewer faces without draft ({len(f["noDraft"])} -> {len(f2["noDraft"])})')

    # ── the coach offers the check for molded parts only ─────────────────────────────────
    supports = pg.evaluate("() => [globalThis.TokcadChecks.supports('molded'), globalThis.TokcadChecks.supports('printed')]")
    check(supports == [True, False], f'the coach offers the molding check for molded parts only ({supports})')

    # ── the per-account limit ────────────────────────────────────────────────────────────
    codes = pg.evaluate("""async (base) => {
        const account = await (await fetch(base + 'api/v1/account')).json();
        const session = globalThis.TokcadMold.state().session;
        const out = [];
        for (let i = 0; i < 25; i++) {
            const r = await fetch(base + 'api/v1/mold/sessions/' + session + '/analyze', {method: 'POST',
                headers: {'content-type': 'application/json', 'x-partmode-csrf': account.csrfToken}, body: '{}'});
            out.push(r.status);
            if (r.status === 429) break;
        }
        return out;
    }""", BASE)
    check(codes[-1] == 429 and all(c == 200 for c in codes[:-1]), f'the hourly limit holds ({len(codes) - 1} more checks, then 429)')

    check(not [e for e in errors if 'favicon' not in e], f'no page errors {errors[:5]}')
    browser.close()

print('ALL CHECKS PASSED' if ok else 'SOME CHECKS FAILED')
sys.exit(0 if ok else 1)
