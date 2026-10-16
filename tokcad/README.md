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
