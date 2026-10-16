"""TOK CAD email accounts, end to end through the browser and the API.

Needs the server with a dev outbox in <state>/mail.json ({"from": ..., "outbox": DIR}).
Run: python tokcad/tests/email_accounts_e2e.py http://127.0.0.1:8099/cad/ OUTBOX_DIR
"""
import glob
import json
import os
import re
import secrets
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1]
OUTBOX = sys.argv[2]
PASS1, PASS2 = 'correct horse battery staple', 'another long passphrase 42'
ok = True


def check(cond, msg):
    global ok
    print(('PASS ' if cond else 'FAIL ') + msg)
    ok = ok and cond


def mails_to(addr, since):
    out = []
    for f in sorted(glob.glob(os.path.join(OUTBOX, '*.json'))):
        if os.path.getmtime(f) >= since:
            m = json.load(open(f, encoding='utf-8'))
            if m['to'] == addr:
                out.append(m)
    return out


def wait_mail(addr, since, subject_part, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        hits = [m for m in mails_to(addr, since) if subject_part in m['subject']]
        if hits:
            return hits[-1]
        time.sleep(0.2)
    return None


def link_in(mail):
    return re.search(r'https?://\S+', mail['text']).group(0)


def status(pg):
    return pg.inner_text('#pm-account-status')


def wait_status(pg, text, timeout=15000):
    pg.wait_for_function(f"() => document.querySelector('#pm-account-status').innerText.includes({json.dumps(text)})",
                         timeout=timeout)


def api(pg, path, body, method='POST'):
    return pg.evaluate("""async ([path, body, method]) => {
        const r = await fetch(path, {method, headers: {'Content-Type': 'application/json'},
                                     body: JSON.stringify(body), credentials: 'same-origin'});
        return [r.status, await r.json().catch(() => ({}))];
    }""", [BASE + path, body, method])


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context()
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    name = 'tok' + secrets.token_hex(3)
    email = f'{name}@example.com'
    t0 = time.time() - 1

    # 0. an email is required
    pg.goto(BASE + 'account', wait_until='networkidle')
    code, body = api(pg, 'api/v1/accounts', {'name': name + 'q', 'password': PASS1})
    check(code == 400 and body.get('error') == 'EMAIL_INVALID', f'signup without an email refused ({code})')

    # 1. sign up: no session, a confirmation mail
    pg.goto(BASE + 'account', wait_until='networkidle')
    pg.fill('#pm-signup-form input[name=name]', name)
    pg.fill('#pm-signup-form input[name=email]', email)
    pg.fill('#pm-signup-form input[name=password]', PASS1)
    pg.click('#pm-signup-form button[type=submit]')
    wait_status(pg, 'Check your email')
    check(not [c for c in ctx.cookies() if 'account' in c['name']], 'signup: no session before the email is confirmed')
    verify = wait_mail(email, t0, 'Confirm')
    check(verify is not None and '/cad/api/v1/email/verify?token=' in verify['text'], 'signup: confirmation mail with a /cad link')

    # 2. sign-in refused until confirmed; the resend form appears
    pg.fill('#pm-login-form input[name=name]', name)
    pg.fill('#pm-login-form input[name=password]', PASS1)
    pg.click('#pm-login-form button[type=submit]')
    wait_status(pg, 'Confirm your email first')
    check(pg.is_visible('#tok-resend-form'), 'unconfirmed sign-in refused, resend form shown')

    # 3. the link confirms and signs in; a second use fails
    link = link_in(verify)
    pg.goto(link, wait_until='networkidle')
    wait_status(pg, 'Email confirmed')
    check(pg.url.rstrip('/').endswith('/cad/account') and pg.is_visible('#pm-dashboard'),
          'confirmation link signs in and lands on /cad/account')
    cookies = [c for c in ctx.cookies() if 'account' in c['name']]
    check(len(cookies) == 1 and cookies[0]['path'] == '/cad', f'session cookie scoped to /cad {[(c["name"], c["path"]) for c in cookies]}')
    pg.goto(BASE.split('/cad')[0] + '/', wait_until='load')
    check('account' not in pg.evaluate('() => document.cookie'), 'session cookie not visible outside /cad')
    pg.goto(link, wait_until='networkidle')
    wait_status(pg, 'expired or was already used')
    check(True, 'confirmation link works only once')

    # 4. sign out, sign in with the email address
    ctx.clear_cookies()
    pg.goto(BASE + 'account', wait_until='networkidle')
    pg.fill('#pm-login-form input[name=name]', email.upper())
    pg.fill('#pm-login-form input[name=password]', PASS1)
    pg.click('#pm-login-form button[type=submit]')
    wait_status(pg, 'Signed in')
    check(pg.is_visible('#pm-dashboard'), 'sign in with the email address (any case)')
    ctx.clear_cookies()

    # 5. the same email again: same reply, the owner is told, no second account
    t1 = time.time() - 1
    code, body = api(pg, 'api/v1/accounts', {'name': name + 'x', 'email': email, 'password': PASS1})
    check(code == 201 and body.get('verificationSent'), f'duplicate email: same reply as a new signup ({code})')
    check(wait_mail(email, t1, 'Your TOK CAD account') is not None, 'duplicate email: owner gets an "already registered" mail')
    code, body = api(pg, 'api/v1/session', {'name': name + 'x', 'password': PASS1})
    check(code == 401, f'duplicate email: no second account created ({code})')

    # 6. forgot -> reset; old passphrase stops working; link is single use
    t2 = time.time() - 1
    pg.goto(BASE + 'account', wait_until='networkidle')
    pg.click('#tok-forgot-open')
    pg.fill('#tok-forgot-form input[name=email]', email)
    pg.click('#tok-forgot-form button[type=submit]')
    wait_status(pg, 'reset link is on its way')
    reset = wait_mail(email, t2, 'Reset')
    check(reset is not None and '/cad/account?reset=' in reset['text'], 'forgot: reset mail with a /cad link')
    rlink = link_in(reset)
    pg.goto(rlink, wait_until='networkidle')
    check(pg.is_visible('#tok-reset-form'), 'reset link opens the new-passphrase form')
    pg.fill('#tok-reset-form input[name=password]', PASS2)
    pg.fill('#tok-reset-form input[name=confirm]', PASS2)
    pg.click('#tok-reset-form button[type=submit]')
    wait_status(pg, 'Passphrase changed')
    check(api(pg, 'api/v1/session', {'name': name, 'password': PASS1})[0] == 401, 'old passphrase refused after reset')
    check(api(pg, 'api/v1/session', {'name': name, 'password': PASS2})[0] == 200, 'new passphrase works')
    tok = rlink.split('reset=')[1]
    check(api(pg, 'api/v1/password/reset', {'token': tok, 'password': PASS1})[0] == 400, 'reset link works only once')

    # 7. forgot for an unknown address: same reply, no mail
    t3 = time.time() - 1
    code, _ = api(pg, 'api/v1/password/forgot', {'email': 'nobody-' + email})
    time.sleep(1)
    check(code == 200 and not mails_to('nobody-' + email, t3), 'forgot for an unknown address: same reply, nothing sent')

    # 8. resend for an unconfirmed account
    n2 = name + 'r'
    e2 = f'{n2}@example.com'
    t4 = time.time() - 1
    api(pg, 'api/v1/accounts', {'name': n2, 'email': e2, 'password': PASS1})
    api(pg, 'api/v1/email/resend', {'email': e2})
    time.sleep(1)
    check(len([m for m in mails_to(e2, t4) if 'Confirm' in m['subject']]) == 2, 'resend sends a new confirmation link')
    first = [m for m in mails_to(e2, t4) if 'Confirm' in m['subject']][0]
    pg.goto(link_in(first), wait_until='networkidle')
    wait_status(pg, 'expired or was already used')
    check(True, 'a resend retires the earlier link')

    # 9. per-address mail limit
    codes = [api(pg, 'api/v1/email/resend', {'email': e2})[0] for _ in range(4)]
    check(codes[-1] == 429, f'per-address mail limit ({codes})')

    # 10. deleting the account frees the address
    ctx.clear_cookies()
    pg.goto(BASE + 'account', wait_until='networkidle')
    pg.fill('#pm-login-form input[name=name]', name)
    pg.fill('#pm-login-form input[name=password]', PASS2)
    pg.click('#pm-login-form button[type=submit]')
    wait_status(pg, 'Signed in')
    csrf = pg.evaluate("async () => (await (await fetch('%sapi/v1/account')).json()).csrfToken" % BASE)
    key = lambda headless: pg.evaluate("""async ([url, csrf, headless]) => (await fetch(url, {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-PartMode-CSRF': csrf},
        body: JSON.stringify({label: 'test agent', access: 'edit', headless})})).status""",
                                      [BASE + 'api/v1/agent-keys', csrf, headless])
    if os.environ.get('TOKCAD_BRANDED') == '1':
        check(key(True) == 400 and key(False) == 201, 'agent keys: normal ones created, server-headless refused')
    gone = pg.evaluate("""async ([url, csrf]) => (await fetch(url, {method: 'DELETE',
        headers: {'Content-Type': 'application/json', 'X-PartMode-CSRF': csrf}, body: '{}'})).status""",
                       [BASE + 'api/v1/account', csrf])
    t5 = time.time() - 1
    api(pg, 'api/v1/accounts', {'name': name + 'n', 'email': email, 'password': PASS1})
    check(gone == 200 and wait_mail(email, t5, 'Confirm') is not None,
          'after deleting the account its email can sign up again')
    check(not errs, f'no page errors {errs}')
    b.close()
print('ALL PASSED' if ok else 'FAILED')
