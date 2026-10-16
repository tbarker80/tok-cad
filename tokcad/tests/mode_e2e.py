"""TOK CAD Beginner / Expert mode and the every-visit start page (branded /cad build).

Run: python tokcad/tests/mode_e2e.py [http://127.0.0.1:8099/cad/] [screenshot dir]
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8099/cad/'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
ok = True


def check(cond, msg):
    global ok
    print(('PASS ' if cond else 'FAIL ') + msg)
    ok = ok and cond


def shot(page, name):
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f'mode_{name}.png'))


def visible(page, selector):
    return page.evaluate('(s) => { const n = document.querySelector(s); return !!n && n.offsetParent !== null; }', selector)


with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(viewport={'width': 1400, 'height': 900})
    ctx.add_cookies([{'name': 'partmode_cookie_consent', 'value': 'essential-v1', 'url': BASE.split('/cad')[0] + '/cad/'}])
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_selector('.tokcad-start', timeout=60000)

    # first visit: "have you used CAD before?"
    check('Have you used CAD before?' in page.inner_text('.tokcad-start'), 'first visit asks whether you know CAD')
    shot(page, '1_question')
    page.click('text=I\'m new to CAD')
    check('Drop a part file here' in page.inner_text('.tokcad-start'), 'then the start page with the upload box')
    check(page.evaluate("() => localStorage.getItem('tokcad-mode')") == 'beginner', 'Beginner is remembered')
    shot(page, '2_start_beginner')

    # Beginner studio: a trimmed ribbon
    page.click('text=Start from scratch')
    page.click('.tokcad-shape:has-text("Block")')
    page.click('.tokcad-form button[type=submit]')
    page.wait_for_function('() => globalThis.TokcadStudio.bodyMeshes().size > 0', timeout=90000)
    page.wait_for_timeout(1500)
    hidden_tabs = [t for t in ('home', 'assembly', 'view', 'manage', 'output') if not visible(page, f'[data-workspace="{t}"]')]
    check(len(hidden_tabs) == 5 and visible(page, '[data-workspace="sketch"]') and visible(page, '[data-workspace="solid"]'),
          f'Beginner shows only the Sketch and 3D Tools tabs (hidden: {hidden_tabs})')
    kept = all(visible(page, s) for s in ('[data-feat="extrude"]', '[data-feat="cut"]', '#bw-hole-wizard-open',
                                         '[data-feat="revolve"]', '[data-feat="fillet"]', '[data-feat="chamfer"]', '[data-feat="shell"]'))
    split_visible = page.evaluate("""() => [...document.querySelectorAll('.ws-ribbon .wsr-label')]
        .some((l) => l.textContent.trim() === 'Split body' && l.offsetParent !== null)""")
    gone = not split_visible and not any(visible(page, s) for s in ('#bw-thread-open', '#bw-weld-bead-open', '#bw-sheet-metal-open'))
    check(kept and gone, 'Beginner keeps extrude, cut, hole, revolve, fillet, chamfer, shell; hides thread, weld, sheet metal')
    check(visible(page, '.tokcad-beginner-only') and 'Measure' in page.inner_text('.tokcad-beginner-only'),
          'Beginner gets a Check group with Measure')
    check('pull a closed sketch' in (page.get_attribute('[data-feat="extrude"]', 'title') or ''),
          'Beginner tooltips explain the tool in plain words')
    check(visible(page, '#tokcad-coach'), 'the coach is open for a beginner')
    shot(page, '3_beginner_studio')

    # switch to Expert from the status bar: everything back, coach closed by default
    page.click('#tokcad-mode-toggle')
    page.wait_for_timeout(500)
    check(all(visible(page, f'[data-workspace="{t}"]') for t in ('home', 'assembly', 'view', 'manage', 'output')),
          'Expert shows every ribbon tab')
    check(visible(page, '#bw-thread-open') and not visible(page, '.tokcad-beginner-only'), 'Expert shows the advanced tools')
    check(not visible(page, '#tokcad-coach'), 'the coach is closed by default for an expert')
    check(page.inner_text('#tokcad-mode-toggle') == 'Expert mode', 'the status bar says Expert mode')
    shot(page, '4_expert_studio')

    # every visit opens on the start page, with "Continue where you left off"
    page.reload(wait_until='networkidle')
    page.wait_for_selector('.tokcad-start', timeout=60000)
    page.wait_for_function("() => document.querySelector('.tokcad-start')?.innerText.includes('Continue where you left off')", timeout=60000)
    check('Have you used CAD before?' not in page.inner_text('.tokcad-start'), 'the CAD question is asked only once')
    check(page.is_visible('.tokcad-seg.is-on:has-text("Expert")'), 'the start page shows the current mode')
    shot(page, '5_return_visit')
    page.click('text=Continue where you left off')
    check(not page.is_visible('.tokcad-start') and page.evaluate('() => globalThis.TokcadStudio.hasContent()'),
          '"Continue where you left off" goes back to the part')

    # switch back to Beginner from the start page
    page.click('#tokcad-start-open')
    page.click('.tokcad-seg:has-text("Beginner")')
    page.keyboard.press('Escape')
    page.wait_for_timeout(500)
    check(not visible(page, '[data-workspace="assembly"]'), 'switching to Beginner on the start page trims the ribbon again')
    check(not errors, f'no page errors {errors[:3]}')
    b.close()
print('ALL PASSED' if ok else 'FAILED')
