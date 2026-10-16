"""TOK CAD engineering coach, end to end (branded /cad build).

Run: python tokcad/tests/coach_e2e.py [http://127.0.0.1:8099/cad/] [screenshot dir]
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


def done_steps(page):
    return page.evaluate("() => globalThis.TokcadCoach.state().steps.filter((s) => s.done).map((s) => s.id)")


with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(accept_downloads=True, viewport={'width': 1400, 'height': 900})
    ctx.add_cookies([{'name': 'partmode_cookie_consent', 'value': 'essential-v1', 'url': BASE.split('/cad')[0] + '/cad/'}])
    ctx.add_init_script("try { if (!localStorage.getItem('tokcad-mode')) localStorage.setItem('tokcad-mode', 'beginner'); } catch (e) {}")
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_selector('.tokcad-start', timeout=60000)
    check(page.is_hidden('#tokcad-coach'), 'no coach on an empty part behind the start screen')

    # a plate from the start screen
    page.click('text=Start from scratch')
    page.click('.tokcad-shape:has-text("Plate with holes")')
    page.click('.tokcad-form button[type=submit]')
    page.wait_for_function('() => globalThis.TokcadStudio.bodyMeshes().size > 0', timeout=90000)
    page.wait_for_timeout(1500)
    check(page.is_visible('#tokcad-coach'), 'coach appears beside the new part')
    check(done_steps(page) == ['base', 'sketches', 'order', 'params'], f'plate ticks base, sketches, order, params ({done_steps(page)})')
    check(page.is_visible('.tokcad-step.is-open[data-step="intent"]'), 'the first open step is "Decide what you\'re making"')
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'coach_1_intent.png'))

    # design intent: saved in the part
    page.fill('.tokcad-intent input[name=purpose]', 'cover plate for a sensor box')
    page.check('.tokcad-intent input[value=machined]')
    page.fill('.tokcad-intent input[name=keyDims]', 'holes 64 x 34 mm apart')
    page.click('.tokcad-intent button[type=submit]')
    page.wait_for_function("() => globalThis.TokcadCoach.state().steps[0].done", timeout=10000)
    intent = page.evaluate("() => globalThis.TokcadStudio.partExtension('intent')")
    check(intent and intent.get('process') == 'machined' and 'sensor' in intent.get('purpose', ''), f'intent saved in the part ({intent})')
    check(page.is_visible('.tokcad-step.is-open[data-step="check"]'), 'the coach moves on to "Check the part"')
    page.click('.tokcad-step[data-step="check"] .tokcad-why summary')
    check('sharp inside corners' in page.inner_text('.tokcad-step[data-step="check"]'), '"Why?" is tailored to machining')
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, 'coach_2_check.png'))

    # check, then export from the coach
    page.click('.tokcad-step[data-step="check"] button:has-text("Measure")')
    page.keyboard.press('Escape')
    page.wait_for_timeout(500)
    check(page.is_visible('.tokcad-step.is-open[data-step="output"]'), 'after checking, the coach moves on to "Hand it over"')
    with page.expect_download(timeout=120000):
        page.click('.tokcad-step[data-step="output"] button:has-text("STEP for a supplier")')
    page.wait_for_timeout(500)
    steps = done_steps(page)
    check('check' in steps and 'output' in steps and len(steps) == 7, f'all 7 steps done ({steps})')
    check('7 of 7' in page.inner_text('#tokcad-coach header'), 'header shows 7 of 7')

    # intent survives a reload (the project is restored from local storage)
    page.reload(wait_until='networkidle')
    page.wait_for_function('() => globalThis.TokcadStudio && globalThis.TokcadStudio.bodyMeshes().size > 0', timeout=90000)
    page.wait_for_timeout(1500)
    intent = page.evaluate("() => globalThis.TokcadStudio.partExtension('intent')")
    check(intent and intent.get('process') == 'machined', 'intent is still there after a reload')
    # every visit opens on the start page: continue to the part, as a returning user would
    page.wait_for_selector('text=Continue where you left off', timeout=30000)
    page.click('text=Continue where you left off')

    # close for this part, bring it back from the status bar
    page.click('.tokcad-coach-close')
    check(page.is_hidden('#tokcad-coach'), 'the coach closes')
    page.click('#tokcad-coach-open')
    check(page.is_visible('#tokcad-coach'), '"Coach" in the status bar brings it back')
    check(not errors, f'no page errors {errors[:3]}')
    b.close()
print('ALL PASSED' if ok else 'FAILED')
