# TOK CAD changes

TOK CAD is a fork of [PartMode](https://github.com/BOMWiki/partmode) (AGPL-3.0), served at
https://tok-share.com/cad. Every change to upstream files is marked with a `TOKCAD:` comment.
Upstream stays the `upstream` remote; merge its releases into the `tokcad` branch.

## Serving under a path prefix

Build with `TOKCAD_BASE_PATH=/cad npm run build`, then run `node dist/server.js` behind a proxy
that strips the prefix (`location /cad/ { proxy_pass http://127.0.0.1:PORT/; }`, passing
`Host $http_host`, `X-Forwarded-For`, `X-Forwarded-Proto`). The build prefixes every URL it emits
for the browser; the server reads the prefix from `release.json` for redirects and cookies.
Under a prefix the session cookie is `__Secure-` scoped to it (a `__Host-` cookie needs `Path=/`).

From Git Bash set `MSYS_NO_PATHCONV=1`, or `/cad` arrives as `C:/Program Files/Git/cad`
(the build refuses it).

Test: start a test nginx with `tokcad/tests/nginx-test.conf` (`nginx -p <dir> -c conf/nginx.conf`,
port 8099) and the server on 4402, then `python tokcad/tests/basepath_e2e.py` (Playwright).

## Upstream gate on Windows

`npm run ci:gate` passes except `smoke:entrypoint`, which needs symlink rights.

## Email-verified accounts

`src/tokcad-accounts.ts` keeps each account's email, its verification state and single-use
tokens (stored as SHA-256 digests) in `tokcad.sqlite` beside the account store, so
`account-store.ts` only gained `setPassword()`. Signup needs an email and gives no session;
sign-in (by name or email) is refused until the link in the confirmation email is opened.
Replies never say whether an address is registered; the owner of a registered address is told
by email instead. Mail per address is limited to 4 an hour.

Mail settings live in `<PARTMODE_STATE_DIR>/mail.json`, never in the repository:

    {"from": "TOK CAD <you@gmail.com>",
     "smtp": {"host": "smtp.gmail.com", "port": 587, "user": "you@gmail.com", "pass": "<app password>"}}

For development use `{"from": "...", "outbox": "C:\path\to\outbox"}`: each message is written
there as JSON instead of being sent.

Upstream's smoke tests sign up without email; run them with `TOKCAD_EMAIL_VERIFICATION=off`.
The server refuses that setting when `NODE_ENV=production`.

Test: `python tokcad/tests/email_accounts_e2e.py http://127.0.0.1:8099/cad/ <outbox>`.

## TOK CAD branding

`TOKCAD_BRAND=1` builds TOK CAD (production builds use it together with `TOKCAD_BASE_PATH=/cad`):
name and logo, TOK CAD's own About, privacy and cookie pages, a cookie banner that matches what
is stored, and a "Source code" link to this repository at the exact commit being served (a
branded build refuses to run from an uncommitted tree). See `src/tokcad-brand.ts`. Only prose
"PartMode" is renamed: header names (`X-PartMode-CSRF`), storage names, protocol ids and the
kernel's STEP tags stay, so files still move between TOK CAD and PartMode.

A branded server also refuses agent keys with the server-headless grant: agents work only on
projects open in the user's browser, so no CAD runs on the server. Google sign-in stays off
(no client id configured) and its controls are removed from the account page.

Upstream's checks run against the plain build, where none of this applies.

## Production (tok-share.com/cad)

- Service `tok-cad` (NSSM, LocalSystem): `node D:\apps\tokcad\server.js`, production mode, port
  5006 on loopback; data in `D:\apps\tokcad-data` (account databases, `mail.json`), closed to
  everyone but SYSTEM, Administrators and the owner. One-time: `tokcad\scripts\install-service.ps1`.
- Deploy (elevated): `tokcad\scripts\deploy.ps1`. It refuses an uncommitted tree or a commit
  that is not on GitHub, builds `/cad` + branded, mirrors `dist\` into `D:\apps\tokcad`, and
  checks the served page names that commit and its source link resolves.
- nginx: `tokcad/nginx/tokcad-locations.conf`, included in the tok-share.com server block, plus
  `limit_req_zone ... zone=tokcad ... rate=240r/m`. Those locations set their own headers, so
  the site-wide CSP (which blocks WebAssembly) does not apply; the studio page's CSP comes from
  the app, with its inline scripts allowed by hash (`studioCspFor` in `src/server.ts`).
- Backup: scheduled task `TOK-CAD-Backup` runs `tokcad\scripts\backup.mjs` nightly into
  `D:\apps\tokcad-backups\<date>` (SQLite `VACUUM INTO`), keeping 14 days.

## Start screen (branded builds)

`src/static/tokcad-start.js` replaces upstream's first-visit welcome with TOK CAD's start screen,
shown for every new, empty part (and from "New part…" in the status bar) unless the user ticks
"Don't show this": drop or browse a STEP / DXF / project file (STEP imports are followed by a
"what next?" card), start from scratch (a sketch on the ground plane, or a primitive), or start
from an example. Primitives (`tokcad-primitives.js`) are generated templates: named parameters
plus ordinary sketch features, so they stay editable. Both act only through
`globalThis.TokcadStudio`, a small hook at the end of `src/static/studio.js`, which emits
`change` (document committed) and `meshes` (kernel rebuild) events. Sketches start on the
ground plane only: the studio's sketch entry offers just the base plane for an empty part.
Test: `python tokcad/tests/start_screen_e2e.py`.
