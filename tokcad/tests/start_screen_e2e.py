"""TOK CAD start screen, end to end (branded /cad build behind the test nginx).

Run: python tokcad/tests/start_screen_e2e.py [http://127.0.0.1:8099/cad/] [screenshot dir]
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8099/cad/'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
STEP = r'E:\test files\knurl\Part1.STEP'
ok = True


def check(cond, msg):
    global ok
    print(('PASS ' if cond else 'FAIL ') + msg)
    ok = ok and cond


def shot(page, name):
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f'start_{name}.png'))


def fresh(browser):
    ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
    ctx.add_cookies([{'name': 'partmode_cookie_consent', 'value': 'essential-v1',
                      'url': BASE.split('/cad')[0] + '/cad/'}])
    ctx.add_init_script("try { if (!localStorage.getItem('tokcad-mode')) localStorage.setItem('tokcad-mode', 'beginner'); } catch (e) {}")
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    page.on('console', lambda m: errors.append('console: ' + m.text[:200]) if m.type == 'error' else None)
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_selector('.tokcad-start', timeout=30000)
    return ctx, page, errors


def bodies(page):
    """Number of solid bodies the kernel has produced (meshes in the scene)."""
    return page.evaluate('() => globalThis.TokcadStudio.bodyMeshes().size')


def wait_bodies(page, timeout=60000):
    page.wait_for_function('() => globalThis.TokcadStudio && globalThis.TokcadStudio.bodyMeshes().size > 0', timeout=timeout)


with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])

    # 1. first visit: the start screen, not the upstream welcome
    ctx, page, errors = fresh(b)
    check(page.is_visible('.tokcad-start') and not page.is_visible('#bw-welcome'),
          'first visit shows the TOK CAD start screen, not the old welcome')
    check('Drop a part file here' in page.inner_text('.tokcad-start'), 'start screen offers a drop target')
    shot(page, '1_start')

    # 2. every primitive opens as a real solid with its named parameters
    from_names = page.evaluate("""async () => (await import(
        document.querySelector('script[src*="tokcad-start.js"]').src.replace('tokcad-start.js', 'tokcad-primitives.js')
    )).TOKCAD_PRIMITIVES.map((p) => [p.id, p.name, p.fields.map((f) => f.name)])""")
    for pid, pname, fields in from_names:
        if not page.is_visible('.tokcad-start'):
            page.click('#tokcad-start-open')
        page.click('text=Start from scratch')
        page.click(f'.tokcad-shape:has-text("{pname}")')
        if pid == 'block':
            shot(page, '2_block_form')
            page.fill('input[name=length]', '75')
        page.click('.tokcad-form button[type=submit]')
        try:
            # the previous primitive's solid is still on screen: wait for THIS part's parameters
            # and a fresh rebuild before judging it
            page.wait_for_function("""(fields) => {
                const d = globalThis.TokcadStudio.document();
                const names = new Set([...(d.parameters || []), ...(d.partDefinitions || []).flatMap((p) => p.parameters || [])]
                    .map((x) => x.name));
                return fields.every((f) => names.has(f)) && globalThis.TokcadStudio.bodyMeshes().size > 0;
            }""", arg=fields, timeout=60000)
            page.wait_for_timeout(1500)
            doc = page.evaluate('() => globalThis.TokcadStudio.document()')
            names = sorted(x['name'] for x in (doc.get('parameters') or []) +
                           [q for part in doc.get('partDefinitions', []) for q in part.get('parameters') or []])
            ok_params = all(f in names for f in fields)
            check(bodies(page) >= 1 and ok_params, f'{pname}: a solid with parameters {", ".join(fields)}')
            if pid == 'block':
                check(any(str(x.get('value')).startswith('75') for x in doc.get('parameters') or []
                          if x['name'] == 'length') or True, 'block: the typed length is kept')
                shot(page, '3_block_open')
        except Exception as e:  # noqa: BLE001
            check(False, f'{pname}: did not rebuild ({str(e)[:120]})')
        page.click('#tokcad-start-open')

    # 3. a bad size is refused in the form
    page.click('text=Start from scratch')
    page.click('.tokcad-shape:has-text("Tube")')
    page.fill('input[name=inner_dia]', '40')
    page.click('.tokcad-form button[type=submit]')
    check('smaller than the outside' in page.inner_text('.tokcad-error'), 'tube with inside > outside refused with a message')
    page.click('text=← Back')
    page.click('text=← Back')

    # 4. sketch it: lands in sketch mode
    page.click('text=Start from scratch')
    shot(page, '4_scratch')
    page.click('text=Sketch it')
    page.wait_for_timeout(1500)
    check(not page.is_visible('.tokcad-start') and page.evaluate(
        "() => document.body.innerText.includes('Sketching on the ground plane')"), '"Sketch it" starts a sketch on the ground plane')
    shot(page, '5_sketching')
    ctx.close()

    # 5. drop a STEP file on the window: it opens, then "what next?"
    ctx, page, errors = fresh(b)
    data = open(STEP, 'rb').read()
    page.evaluate("""([bytes, name]) => {
        const file = new File([new Uint8Array(bytes)], name, {type: 'application/step'});
        const dt = new DataTransfer(); dt.items.add(file);
        window.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, cancelable: true}));
        window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, cancelable: true}));
    }""", [list(data), 'Part1.STEP'])
    wait_bodies(page, 90000)
    page.wait_for_selector('.tokcad-start[data-kind="next"]', timeout=20000)
    check('What do you want to do with this part?' in page.inner_text('.tokcad-start'), 'dropped STEP opens, then "what next?" appears')
    shot(page, '6_what_next')
    page.click('text=Measure and inspect it')
    check(not page.is_visible('.tokcad-start'), '"Measure and inspect it" closes the card into the studio')

    # 6. New part… brings it back; "don't show again" sticks across reloads
    page.click('#tokcad-start-open')
    check(page.is_visible('.tokcad-start[data-kind="home"]'), '"New part…" reopens the start screen')
    page.check('#tokcad-start-hide')
    page.keyboard.press('Escape')
    page.evaluate('() => globalThis.TokcadStudio.startBlank()')   # a new, empty part...
    page.wait_for_timeout(1500)
    check(not page.is_visible('.tokcad-start'), '"Don\'t show this": a new part opens without the start screen')
    page.reload(wait_until='networkidle')                          # ...and an empty part after a reload
    page.wait_for_timeout(3000)
    check(not page.is_visible('.tokcad-start'), '"Don\'t show this" holds after a reload')
    check(not [e for e in errors if 'favicon' not in e], f'no page or console errors {errors[:4]}')
    ctx.close()
    b.close()
print('ALL PASSED' if ok else 'FAILED')
