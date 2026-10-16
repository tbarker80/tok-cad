import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPartModeAboutHtml } from '../src/about.js';
import { buildPartModeHelpManifest, renderPartModeHelpHtml } from '../src/help.js';
import {
  aboutHtml, brandAccountHtml, brandHtml, BRANDED_ASSETS, brandScript, COOKIE_BANNER_TEXT, cookiesPage, studioExtras,
  markSvg, privacyPage, type BrandContext,
} from '../src/tokcad-brand.js';

interface AssetEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const sourceRoot = resolve(repositoryRoot, 'src');
const staticRoot = resolve(sourceRoot, 'static');
const distRoot = resolve(repositoryRoot, 'dist');
const productVersion = '8.0.0';

// TOKCAD: the app can be served under a path prefix (TOKCAD_BASE_PATH, e.g. "/cad") behind a
// reverse proxy that strips it, so the server's own routes stay unchanged. Every URL the build
// emits for the browser gets the prefix; the server reads it back from release.json.
const BASE_PATH = (() => {
  const raw = (process.env.TOKCAD_BASE_PATH ?? '').trim().replace(/\/+$/, '');
  if (raw && !/^\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(raw)) {
    throw new Error(`TOKCAD_BASE_PATH must look like "/cad", not ${JSON.stringify(raw)}.`);
  }
  return raw;
})();
// Root-absolute app URLs in quotes, attributes and CSS url(): "/api/...", '/assets/...', ...
// Not the API sub-paths account.js passes to apiRequest(), which are relative to its API_ROOT.
const APP_URL = /(?<!apiRequest\()(?<!currentTarget, )(["'`(])\/(?=(?:api|assets|help|account|about|privacy|cookies|auth|mcp)(?:[\/?#"'`)]))/g;
// Attribute links to the app's root: href="/" and href="/#..."
const ROOT_LINK = /((?:href|action)=["'])\/(?=["'#?])/g;

// TOKCAD: TOKCAD_BRAND=1 builds TOK CAD (name, logo, legal pages, source link); see src/tokcad-brand.ts.
const BRAND = process.env.TOKCAD_BRAND === '1';
const TOKCAD_REPO = (process.env.TOKCAD_SOURCE_REPO ?? 'https://github.com/tbarker80/tok-cad').replace(/\/+$/, '');
const TOKCAD_PUBLIC_URL = (process.env.TOKCAD_PUBLIC_URL ?? `https://tok-share.com${BASE_PATH}`).replace(/\/+$/, '');
// Under a path prefix the session cookie is __Secure- (src/server.ts sessionCookieName).
const SESSION_COOKIE = BASE_PATH ? '__Secure-partmode_account' : '__Host-partmode_account';

function withBase(text: string): string {
  if (!BASE_PATH) return text;
  return text
    .replace(APP_URL, `$1${BASE_PATH}/`)
    .replace(ROOT_LINK, `$1${BASE_PATH}/`)
    .replaceAll('Path=/;', `Path=${BASE_PATH};`);
}

const STATIC_FILES = Object.freeze([
  'account.css',
  'account.js',
  'base.css',
  'edit.css',
  'model.css',
  'partmode-mark.svg',
  'privacy.css',
  'privacy.js',
  'tokcad.css',                  // TOKCAD: start screen and coach (loaded by branded builds)
  'tokcad-primitives.js',
  'tokcad-start.js',
  'tokcad-coach.js',
  'studio-agent-service.js',
  'studio-addin-api.js',
  'studio-advanced-fillet.js',
  'studio-advanced-mates.js',
  'studio-advanced-patterns.js',
  'studio-analytic-mate-reference.js',
  'studio-assembly-drag.js',
  'studio-assembly-edit-context.js',
  'studio-assembly-constraint-core.js',
  'studio-assembly-drawing-plan.js',
  'studio-assembly-features.js',
  'studio-brep-evidence.js',
  'studio-cloud-agent-bridge.js',
  'studio-document-history.js',
  'studio-direct-edit.js',
  'studio-drawing-book.js',
  'studio-drawing-annotations.js',
  'studio-drawing-dxf.js',
  'studio-drawing-pdf.js',
  'studio-drawing-standards.js',
  'studio-drawing-tables.js',
  'studio-drawing-svg.js',
  'studio-drawing-views.js',
  'studio-expression.js',
  'studio-feature-diagnostics.js',
  'studio-feature-rebuild-plan.js',
  'studio-imported-topology-registry.js',
  'studio-input-customization.js',
  'studio-hole-wizard.js',
  'studio-jet-engine.js',
  'studio-kernel.worker.js',
  'studio-kernel-robustness.js',
  'studio-inline-profile-semantics.js',
  'studio-mechanical-mates.js',
  'studio-offset-feature-history.js',
  'studio-part-configurations.js',
  'studio-part-drawing.js',
  'studio-pdm.js',
  'studio-pattern-feature-history.js',
  'studio-profile-feature-history.js',
  'studio-project-v5.js',
  'studio-project-bundle.js',
  'studio-selection-tools.js',
  'studio-scene-settings.js',
  'studio-sketch-infer.js',
  'studio-sketch-instances.js',
  'studio-sketch-constraint-edit.js',
  'studio-sketch-drag.js',
  'studio-sketch-pierce.js',
  'studio-sketch-solver.js',
  'studio-sha256.js',
  'studio-sheet-metal.js',
  'studio-smart-fasteners.js',
  'studio-step-import-healing.js',
  'studio-step-normalization.js',
  'studio-storage.js',
  'studio-standard-parts.js',
  'studio-structural-members.js',
  'studio-structural-treatments.js',
  'studio-weld-beads.js',
  'studio-templates.js',
  'studio-topo-naming.js',
  'studio-topology-reference-resolver.js',
  'studio-topology-vertices.js',
  'studio-thread.js',
  'studio-v5-assembly.js',
  'studio-v5-feature-types.js',
  'studio-v5-inspection.js',
  'studio-v5-modeling.js',
  'studio-v5-runtime-document.js',
  'studio-v6-interaction.js',
  'studio-v6-ui-registry.js',
  'studio-view-states.js',
  'studio.css',
  'studio.js',
  'vendor/LICENSE-LGPL-2.1.txt',
  'vendor/LICENSE-OCCT-exception.txt',
  'vendor/LICENSE-replicad.txt',
  'vendor/LICENSE-three.txt',
  'vendor/NOTICE-replicad.txt',
  'vendor/OrbitControls.js',
  'vendor/TransformControls.js',
  'vendor/replicad-oc.module.js',
  'vendor/replicad.module.js',
  'vendor/replicad_single.wasm',
  'vendor/three.core.min.js',
  'vendor/three.module.min.js',
]);

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function releaseSha(): string {
  const fromEnvironment = process.env.PARTMODE_RELEASE_SHA?.trim();
  if (fromEnvironment && /^[0-9a-f]{40}$/.test(fromEnvironment)) return fromEnvironment;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
  } catch {
    // A first local build may happen before the initial commit.
  }
  return 'local';
}

const sourceAssets = STATIC_FILES.map((path) => ({
  path,
  content: readFileSync(resolve(staticRoot, path)),
}));
const versionHash = createHash('sha256');
for (const asset of sourceAssets) {
  versionHash.update(asset.path);
  versionHash.update('\0');
  versionHash.update(asset.content);
  versionHash.update('\0');
}
versionHash.update(`tokcad:${BASE_PATH}:${BRAND ? 'brand' : 'plain'}`);   // TOKCAD
const assetVersion = versionHash.digest('hex').slice(0, 16);
const assetRoot = resolve(distRoot, 'assets', assetVersion);
const exactReleaseSha = releaseSha();
const brand: BrandContext = {
  name: 'TOK CAD',
  publicUrl: TOKCAD_PUBLIC_URL,
  repoUrl: TOKCAD_REPO,
  sourceUrl: `${TOKCAD_REPO}/tree/${exactReleaseSha}`,
  operator: 'Tokeena Engineering',
  contactUrl: 'https://tok-eng.com',
  assetVersion,
  effective: '15 October 2026',
};
if (BRAND && !/^[0-9a-f]{40}$/.test(exactReleaseSha)) {
  throw new Error('A TOK CAD build needs a committed release: its source link names the exact commit.');
}

rmSync(distRoot, { recursive: true, force: true });
mkdirSync(assetRoot, { recursive: true });

const assetManifest: AssetEntry[] = [];
for (const asset of sourceAssets) {
  const destination = resolve(assetRoot, asset.path);
  mkdirSync(dirname(destination), { recursive: true });
  let output = asset.content;
  if (/\.(?:css|js|svg|txt)$/.test(asset.path)) {
    let text = asset.content.toString('utf8').replaceAll('/static/', `/assets/${assetVersion}/`);
    if (BRAND && BRANDED_ASSETS.includes(asset.path)) text = brandScript(text, brand);   // TOKCAD
    if (BRAND && asset.path === 'partmode-mark.svg') text = markSvg(brand);
    output = Buffer.from(withBase(text));
  }
  writeFileSync(destination, output);
  assetManifest.push({
    path: asset.path,
    bytes: output.byteLength,
    sha256: sha256(output),
  });
}

const UPSTREAM_BANNER_TEXT = 'PartMode uses essential first-party cookies for this choice, your account session if you sign in, and a short-lived browser binding only while you connect Google. Browser projects stay on your device. Projects opened with an explicitly granted headless agent key are stored under your account. There are no analytics, advertising, or third-party tracking cookies.';
const privacyBanner = `
    <aside class="pm-cookie-banner" id="pm-cookie-banner" role="dialog" aria-labelledby="pm-cookie-title" aria-describedby="pm-cookie-copy" hidden>
      <div class="pm-cookie-copy">
        <strong id="pm-cookie-title">Essential storage, no tracking</strong>
        <p id="pm-cookie-copy">${BRAND ? COOKIE_BANNER_TEXT(brand) : UPSTREAM_BANNER_TEXT}</p>
        <div class="pm-cookie-links"><a href="/cookies">Cookie details and settings</a><a href="/privacy">Privacy notice</a></div>
      </div>
      <div class="pm-cookie-actions">
        <button type="button" id="pm-cookie-essential" data-cookie-essential>Use essential only</button>
      </div>
    </aside>`;

let html = readFileSync(resolve(sourceRoot, 'page.html'), 'utf8')
  .replaceAll('/static/', `/assets/${assetVersion}/`)
  .replace(/\?v=[0-9a-f]+/g, '');
html = html.replace(
  '</head>',
  `    <meta name="partmode-release" content="${exactReleaseSha}" />\n` +
    `    <link rel="stylesheet" href="/assets/${assetVersion}/privacy.css" />\n` +
    '  </head>',
);
html = html.replace(
  '</body>',
  `${privacyBanner}\n    <script src="/assets/${assetVersion}/privacy.js" defer></script>\n  </body>`,
);
writeFileSync(resolve(distRoot, 'index.html'), withBase(BRAND ? studioExtras(brandHtml(html, brand), brand) : html));

const helpManifest = buildPartModeHelpManifest({
  version: productVersion,
  releaseSha: exactReleaseSha,
  readSource: (sourcePath) => readFileSync(resolve(repositoryRoot, sourcePath), 'utf8'),
});
const helpHtml = renderPartModeHelpHtml(helpManifest, { assetVersion });
writeFileSync(resolve(distRoot, 'help.html'), withBase(BRAND ? brandHtml(helpHtml, brand) : helpHtml));
writeFileSync(resolve(distRoot, 'help-resources.json'), `${JSON.stringify(helpManifest, null, 2)}\n`);
writeFileSync(resolve(distRoot, 'about.html'), withBase(BRAND ? aboutHtml(brand) : renderPartModeAboutHtml({
  assetVersion,
  releaseSha: exactReleaseSha,
  version: productVersion,
})));

const accountHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Sign in to PartMode and manage revocable keys for browser-approved local CAD or explicitly granted server-headless CAD." />
    <meta name="robots" content="noindex,nofollow" />
    <meta name="partmode-release" content="${exactReleaseSha}" />
    <title>Sign in | PartMode</title>
    <link rel="canonical" href="https://partmode.com/account" />
    <link rel="icon" href="/assets/${assetVersion}/partmode-mark.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/assets/${assetVersion}/account.css" />
  </head>
  <body class="pm-account-route">
    <main id="pm-account-app" aria-busy="true">
      <header class="pm-account-header">
        <div>
          <p class="pm-account-kicker">PartMode account</p>
          <h1>Sign in or create an account</h1>
          <p class="pm-account-lede">Use a PartMode account to create a revocable key for Codex or another agent. Choose either visible approval for a project that stays in your browser, or an explicit per-key headless grant for a project stored and run on the PartMode server.</p>
        </div>
        <a href="/">Back to CAD</a>
      </header>

      <p id="pm-account-status" role="status" aria-live="polite"></p>

      <div id="pm-auth-view">
        <section id="pm-google-auth" class="pm-google-auth">
          <div>
            <p class="pm-account-kicker">Fastest setup</p>
            <h2>Continue with Google</h2>
            <p id="pm-google-note" class="pm-account-note">Checking Google sign-in availability. PartMode will request a stable account identifier and basic profile, not your email.</p>
          </div>
          <a id="pm-google-signin" class="pm-google-button" href="/auth/google/start" hidden>Continue with Google</a>
        </section>

        <form id="pm-signup-form" autocomplete="on">
          <div>
            <p class="pm-account-kicker">New account</p>
            <h2>Create account</h2>
            <p class="pm-account-note">Local CAD never requires an account. We email you a link to confirm your address before the account can sign in.</p>
          </div>
          <label>Account name
            <input name="name" type="text" required minlength="3" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{2,39}" autocomplete="username" spellcheck="false" placeholder="workshop-name" />
          </label>
          <label>Email
            <input name="email" type="email" maxlength="254" autocomplete="email" spellcheck="false" placeholder="you@example.com" />
          </label>
          <label>Passphrase
            <input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password" placeholder="12 characters minimum" />
          </label>
          <button type="submit">Create account</button>
        </form>

        <form id="pm-login-form" autocomplete="on">
          <div>
            <p class="pm-account-kicker">Existing account</p>
            <h2>Sign in</h2>
            <p class="pm-account-note">Signing in lets this browser appear as an online PartMode tab to agents using one of your keys.</p>
          </div>
          <label>Account name or email
            <input name="name" type="text" required minlength="3" maxlength="254" autocomplete="username" spellcheck="false" />
          </label>
          <label>Passphrase
            <input name="password" type="password" required minlength="12" maxlength="256" autocomplete="current-password" />
          </label>
          <button type="submit">Sign in</button>
          <button type="button" id="tok-forgot-open" class="tok-link-button">Forgot your passphrase?</button>
        </form>

        <form id="tok-resend-form" hidden>
          <div>
            <p class="pm-account-kicker">Confirm your email</p>
            <h2>Send a new link</h2>
            <p class="pm-account-note">The confirmation link expires after 24 hours. Enter the address you signed up with and we will send a new one.</p>
          </div>
          <label>Email
            <input name="email" type="email" required maxlength="254" autocomplete="email" spellcheck="false" />
          </label>
          <button type="submit">Send a new link</button>
        </form>

        <form id="tok-forgot-form" hidden>
          <div>
            <p class="pm-account-kicker">Forgot your passphrase</p>
            <h2>Reset it by email</h2>
            <p class="pm-account-note">We send a reset link to your account's email address. It works once, for one hour.</p>
          </div>
          <label>Email
            <input name="email" type="email" required maxlength="254" autocomplete="email" spellcheck="false" />
          </label>
          <button type="submit">Send reset link</button>
        </form>

        <form id="tok-reset-form" hidden>
          <div>
            <p class="pm-account-kicker">Reset</p>
            <h2>Choose a new passphrase</h2>
            <p class="pm-account-note">This signs out every browser signed in to the account.</p>
          </div>
          <label>New passphrase
            <input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password" placeholder="12 characters minimum" />
          </label>
          <label>Repeat it
            <input name="confirm" type="password" required minlength="12" maxlength="256" autocomplete="new-password" />
          </label>
          <button type="submit">Set passphrase</button>
        </form>
      </div>

      <div id="pm-dashboard" hidden>
        <section class="pm-account-panel">
          <div class="pm-account-summary">
            <div>
              <p class="pm-account-kicker">Signed in</p>
              <h2 id="pm-account-name">PartMode account</h2>
              <p class="pm-account-note">Open PartMode CAD in this signed-in browser for visible project-scoped approval, or create a separately granted headless key for durable server projects.</p>
              <p class="pm-account-note">Signing out closes active browser relay and headless execution sessions. It keeps agent keys and durable headless project records in the account.</p>
            </div>
            <div class="pm-account-actions">
              <a href="/">Open CAD</a>
              <button type="button" id="pm-logout">Sign out</button>
            </div>
          </div>
        </section>

        <section class="pm-account-panel">
          <p class="pm-account-kicker">Sign-in methods</p>
          <h2>Google</h2>
          <div class="pm-auth-method-row">
            <p id="pm-google-connection" class="pm-account-note">Checking Google connection...</p>
            <div class="pm-account-actions">
              <button type="button" id="pm-google-link" hidden>Connect Google</button>
              <button type="button" id="pm-google-unlink" hidden>Disconnect Google</button>
            </div>
          </div>
          <p class="pm-account-note">PartMode links Google by its stable provider identifier. Matching names are never used to merge accounts.</p>
        </section>

        <section class="pm-account-panel">
          <p class="pm-account-kicker">Agent keys</p>
          <h2>Create a key</h2>
          <p class="pm-account-note">The secret is shown once. Put it in the agent host's secret settings and send it only as an Authorization bearer token. Never paste it into a prompt, URL, or project file.</p>
          <form id="pm-key-form">
            <label>Key label
              <input name="label" type="text" required maxlength="80" placeholder="Workshop Codex" autocomplete="off" />
            </label>
            <label>Access ceiling
              <select name="access">
                <option value="edit">Read and propose edits</option>
                <option value="read-only">Read only</option>
              </select>
            </label>
            <label class="pm-key-headless">
              <input name="headless" type="checkbox" />
              Allow headless server sessions. By enabling this per-key grant, you consent to this edit key running CAD without a browser or per-session approval. PartMode stores each opened project's ID, name, revision, full document JSON, canonical hash, and timestamps until you delete the account. The choice cannot be changed later.
            </label>
            <button type="submit">Create key</button>
          </form>

          <aside id="pm-key-secret" class="pm-key-secret" hidden aria-labelledby="pm-key-secret-title">
            <p class="pm-account-kicker">Shown once</p>
            <h2 id="pm-key-secret-title">Copy this key now</h2>
            <code id="pm-key-secret-value"></code>
            <div class="pm-secret-actions">
              <button type="button" id="pm-key-copy">Copy key</button>
              <button type="button" id="pm-key-dismiss">I stored it, hide key</button>
            </div>
          </aside>

          <ul id="pm-key-list" aria-label="Agent keys"></ul>
        </section>

        <section class="pm-account-panel">
          <p class="pm-account-kicker">Connect an agent</p>
          <h2>Hosted MCP</h2>
          <p>Configure your agent with endpoint <code>https://partmode.com/mcp</code> and the key as an <code>Authorization: Bearer</code> secret.</p>
          <p><strong>Browser-approved local project:</strong> use a normal key. The agent lists online tabs and requests one visible CAD approval. The project stays in browser storage; commands and results are transient relay data.</p>
          <p><strong>Server-headless durable project:</strong> use an edit key created with the headless grant. The agent opens a project with <code>partmode_headless_open</code> and no browser approval. Execution sessions are temporary, but committed document records survive restarts and key revocation until account deletion. Headless refuses <code>cad_artifact</code>, <code>cad_ui</code>, and <code>cad_events</code>; its dedicated export currently produces STEP.</p>
          <p><strong>Codex:</strong> store the copied key in the <code>PARTMODE_AGENT_KEY</code> environment variable used to launch Codex, then add the server without putting the secret in a prompt, command argument, or repository file:</p>
          <pre class="pm-agent-config"><code>codex mcp add partmode --url https://partmode.com/mcp --bearer-token-env-var PARTMODE_AGENT_KEY</code></pre>
          <p class="pm-account-note">Start a new Codex session after adding the server. For the browser path, keep the intended PartMode tab open and ask Codex to list online tabs. For the headless path, ask it to open the intended stable project ID.</p>
          <p class="pm-account-note"><a href="/help#agents">Read the complete agent workflow and troubleshooting guide</a>.</p>
          <p class="pm-account-note">Browser-relay arguments and results are handled transiently in memory over HTTPS and are not end-to-end encrypted. Headless committed documents are different: they are stored durably under your account.</p>
        </section>

        <section class="pm-account-panel pm-danger-zone">
          <p class="pm-account-kicker">Account lifecycle</p>
          <h2>Delete account</h2>
          <p class="pm-account-note">This revokes every key, signs out every browser, closes active browser relay and headless sessions, and deletes all durable server-headless project records. Local CAD projects in browser storage are not deleted.</p>
          <button type="button" id="pm-delete-account">Delete account</button>
        </section>
      </div>

      <footer class="pm-account-footer">
        <a href="/help">Help</a>
        <a href="/privacy">Privacy</a>
        <a href="/cookies">Cookie details</a>
        <a href="https://github.com/BOMWiki/partmode">Source</a>
      </footer>
    </main>
    <script src="/assets/${assetVersion}/account.js" defer></script>
  </body>
</html>
`;
writeFileSync(resolve(distRoot, 'account.html'), withBase(BRAND ? brandAccountHtml(accountHtml, brand) : accountHtml));

const privacyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="How PartMode handles browser storage, cookies, and privacy." />
    <meta name="partmode-release" content="${exactReleaseSha}" />
    <title>Privacy | PartMode</title>
    <link rel="canonical" href="https://partmode.com/privacy" />
    <link rel="icon" href="/assets/${assetVersion}/partmode-mark.svg" type="image/svg+xml" />
    <style>
      :root { color-scheme: dark; font: 16px/1.65 Inter, ui-sans-serif, system-ui, sans-serif; background: #101318; color: #e9edf2; }
      body { margin: 0; }
      main { width: min(720px, calc(100% - 40px)); margin: 0 auto; padding: 64px 0 96px; }
      a { color: #9fc8ff; }
      h1, h2 { line-height: 1.15; }
      h1 { font-size: clamp(2rem, 6vw, 3.5rem); margin-bottom: 1rem; }
      h2 { margin-top: 2.2rem; }
      .back { display: inline-block; margin-bottom: 2rem; }
      .updated { color: #aeb7c3; }
      code { color: #c7ddfa; }
      .legal-nav { display: flex; gap: 16px; flex-wrap: wrap; margin: 2rem 0; }
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="/">← Back to PartMode</a>
      <h1>Privacy</h1>
      <p class="updated">Effective 2 August 2026.</p>
      <nav class="legal-nav" aria-label="Privacy pages"><a href="/cookies">Cookie details and settings</a><a href="https://github.com/BOMWiki/partmode">Project source</a></nav>
      <p>PartMode is a local-first browser CAD application. Anonymous and browser-approved projects, geometry, recovery, and editing history stay in browser storage unless you explicitly download or open a project file. Server-headless agent projects are a separate, opt-in path: when you create an edit key with the headless grant and use it to open a project, PartMode stores that committed document under your account.</p>
      <h2>Who is responsible</h2>
      <p>Each hosted PartMode deployment has its own operator. Contact that operator through the privacy channel published by the deployment.</p>
      <h2>Cookies and analytics</h2>
      <p>PartMode does not use analytics, advertising trackers, third-party tracking pixels, or analytics cookies. After you make a choice, the browser sets one host-only first-party cookie to remember that you selected essential storage only. If you choose to sign in, PartMode also sets a secure, HttpOnly account-session cookie. Starting Google sign-in sets a separate secure, HttpOnly browser-binding cookie for no more than ten minutes so the callback can be matched to the browser that started it. These cookies do not grant consent to future analytics.</p>
      <p>See the <a href="/cookies">cookie details and settings</a> page for its exact name, purpose, duration, and deletion control.</p>
      <h2>Essential browser storage</h2>
      <p>PartMode uses localStorage and IndexedDB for local project recovery, application preferences, first-run state, and CAD session continuity. This storage is necessary for the local-first features you request and is not used to track you across websites.</p>
      <h2>Optional accounts and agent keys</h2>
      <p>If you create an account, PartMode stores an internal account name, account creation time, hashed web-session tokens, and agent-key metadata such as label, access ceiling, immutable headless-grant choice, creation, last-use, expiry, and revocation times. Passphrase accounts also store a salted password verifier. Raw passwords, raw session tokens, and raw agent keys are not stored. A new agent key is displayed once.</p>
      <p>You may instead sign in with Google or explicitly connect Google to an existing passphrase account. PartMode requests only Google's stable account identifier and basic profile, not your email address. It stores the Google issuer and stable identifier plus an optional display-name snapshot. It does not retain Google's authorization code, ID token, access token, or refresh token. Identities are never linked because profile names match.</p>
      <p>You can disconnect Google when another sign-in method remains, revoke individual agent keys, sign out, or delete the PartMode account from <a href="/account">Agent access</a>. Deleting a PartMode account does not delete the underlying Google account.</p>
      <h2>Browser-approved agent relay</h2>
      <p>A normal agent key identifies an agent but grants no CAD access by itself. When you approve a live, project-scoped browser session, PartMode relays that session's typed commands and results through the service over HTTPS. The browser project is not uploaded to account storage. Relay payloads are bounded, held transiently in process memory, and are not written to the account database or an offline queue. The relay is not end-to-end encrypted, so the PartMode service transiently handles those typed payloads.</p>
      <h2>Server-headless agent projects</h2>
      <p>Headless CAD requires an edit key created with an explicit headless grant. Enabling it is per-key consent for that key to run CAD on the PartMode server without a browser or per-session human approval. The grant cannot be added to an existing key. For each project opened this way, PartMode stores the account ID, project ID, project name, revision, full document JSON, canonical document hash, creation time, and update time. The document JSON contains the complete committed parametric project and geometry recipe.</p>
      <p>Headless execution sessions are temporary, bound to the exact key, and expire in at most one hour. The committed document is durable and survives session expiry, key revocation, service restarts, and deployments so another headless-granted key on the same account can reopen the same project ID. Revoking a key prevents further authentication and closes its live headless sessions, but does not delete durable documents. Signing out closes active browser relay and headless execution sessions while keeping keys and durable records. Those records remain until account deletion. Headless sessions have no visible studio: <code>cad_artifact</code>, <code>cad_ui</code>, and <code>cad_events</code> are unavailable; the dedicated headless artifact export currently produces STEP.</p>
      <h2>Network requests</h2>
      <p>The browser CAD application loads its HTML, JavaScript, WebAssembly kernel, styles, and icons from <code>partmode.com</code>. Browser CAD evaluation happens on your device and no account is required. Signed-in browser tabs make bounded long-poll requests so an approved agent can connect. The explicit headless path sends typed MCP requests to PartMode, where a worker-thread CAD runtime evaluates the account's server project. PartMode does not embed Google scripts, frames, or tracking assets. If you choose Continue with Google, the browser navigates to <code>accounts.google.com</code> and Google processes the sign-in request under <a href="https://policies.google.com/privacy">Google's privacy policy</a> before returning you to PartMode.</p>
      <p>As with any website, PartMode and its delivery and security provider, Cloudflare, receive connection metadata such as IP address, user agent, requested URL, and request time as needed to deliver and protect the service.</p>
      <h2>Retention and your choices</h2>
      <p>The preference cookie expires after 180 days, the Google browser-binding cookie after no more than ten minutes, and an account session after 30 days unless you sign out earlier. Account, linked-identity, and agent-key metadata remains until you disconnect the identity or delete the account; revoked-key metadata may remain with its revocation time until account deletion. Browser-local CAD projects remain on your device until you delete them in PartMode or clear this site's browser data, and PartMode stores no relationship between the account and those local projects. Server-headless project records remain under the account until account deletion; there is currently no separate per-project deletion control. Deleting the account closes active headless sessions and removes linked identities, credentials, keys, and every durable headless document. It does not remove browser-local projects or the underlying Google account.</p>
      <p>You can delete the preference cookie from <a href="/cookies">cookie settings</a> or your browser. For a hosted deployment, you can ask its operator about access, deletion, restriction, portability, or objection. Where applicable, you may complain to your local data-protection authority.</p>
      <h2>Future optional analytics</h2>
      <p>If optional analytics are introduced later, they will remain disabled until you make a separate, informed opt-in choice. The current essential-only cookie is not consent for future analytics.</p>
      <h2>Contact</h2>
      <p>For a hosted deployment, use the operator's published privacy channel. Source-code security reports can use the repository's private vulnerability-reporting form.</p>
    </main>
  </body>
</html>
`;
writeFileSync(resolve(distRoot, 'privacy.html'), withBase(BRAND ? privacyPage(brand, SESSION_COOKIE) : privacyHtml));

const cookiesHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="PartMode cookie and browser-storage details and controls." />
    <meta name="partmode-release" content="${exactReleaseSha}" />
    <title>Cookie settings | PartMode</title>
    <link rel="canonical" href="https://partmode.com/cookies" />
    <link rel="icon" href="/assets/${assetVersion}/partmode-mark.svg" type="image/svg+xml" />
    <style>
      :root { color-scheme: dark; font: 16px/1.65 Inter, ui-sans-serif, system-ui, sans-serif; background: #101318; color: #e9edf2; }
      body { margin: 0; }
      main { width: min(860px, calc(100% - 40px)); margin: 0 auto; padding: 64px 0 96px; }
      a { color: #9fc8ff; }
      h1, h2 { line-height: 1.15; }
      h1 { font-size: clamp(2rem, 6vw, 3.5rem); margin-bottom: 1rem; }
      h2 { margin-top: 2.2rem; }
      .back { display: inline-block; margin-bottom: 2rem; }
      .updated, #pm-cookie-status { color: #aeb7c3; }
      table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
      th, td { padding: 12px; border: 1px solid #3a424d; text-align: left; vertical-align: top; }
      th { background: #171b21; }
      code { color: #c7ddfa; overflow-wrap: anywhere; }
      .choice { padding: 18px; border: 1px solid #3a424d; border-radius: 8px; background: #171b21; }
      .choice-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
      button { min-height: 40px; padding: 8px 16px; border: 1px solid #6e7b8c; border-radius: 5px; color: #f5f7fa; background: #262d36; font: inherit; font-weight: 700; cursor: pointer; }
      button[data-cookie-essential] { color: #07121d; background: #a9d1ff; border-color: #a9d1ff; }
      button:focus-visible, a:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
      @media (max-width: 680px) {
        table, thead, tbody, tr, th, td { display: block; }
        thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
        td { border-top: 0; }
        td::before { content: attr(data-label); display: block; color: #aeb7c3; font-size: 12px; font-weight: 700; text-transform: uppercase; }
      }
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="/">← Back to PartMode</a>
      <h1>Cookie details and settings</h1>
      <p class="updated">Effective 2 August 2026.</p>
      <p>PartMode currently uses no optional cookies. It uses one first-party preference cookie, an account-session cookie only when you choose to sign in, a short-lived browser-binding cookie only while you connect Google, and essential local browser storage. Rejecting optional cookies does not reduce the CAD application because there are no optional services to load.</p>
      <section class="choice" aria-labelledby="pm-choice-title">
        <h2 id="pm-choice-title">Your current choice</h2>
        <p id="pm-cookie-status" role="status" aria-live="polite">Checking this browser…</p>
        <div class="choice-actions">
          <button type="button" data-cookie-essential>Use essential only</button>
          <button type="button" id="pm-cookie-reset">Forget my cookie choice</button>
        </div>
      </section>
      <h2>Cookie inventory</h2>
      <table>
        <thead><tr><th>Name</th><th>Provider</th><th>Purpose</th><th>Category</th><th>Duration</th></tr></thead>
        <tbody>
          <tr>
            <td data-label="Name"><code>partmode_cookie_consent</code></td>
            <td data-label="Provider"><code>partmode.com</code>, first party</td>
            <td data-label="Purpose">Remembers that you selected essential storage only, so the notice is not repeated on every visit.</td>
            <td data-label="Category">Strictly necessary preference</td>
            <td data-label="Duration">180 days</td>
          </tr>
          <tr>
            <td data-label="Name"><code>__Host-partmode_account</code></td>
            <td data-label="Provider"><code>partmode.com</code>, first party</td>
            <td data-label="Purpose">Keeps you signed in so you can manage agent keys and make this browser available for a live, project-scoped approval. It is set only after signup or sign-in and is Secure and HttpOnly.</td>
            <td data-label="Category">Strictly necessary account session</td>
            <td data-label="Duration">30 days or until sign-out</td>
          </tr>
          <tr>
            <td data-label="Name"><code>__Host-partmode_oidc</code></td>
            <td data-label="Provider"><code>partmode.com</code>, first party</td>
            <td data-label="Purpose">Binds a Google sign-in callback to the browser that started it. It contains a random one-time value, is Secure and HttpOnly, and is cleared when the callback finishes.</td>
            <td data-label="Category">Strictly necessary authentication security</td>
            <td data-label="Duration">Up to 10 minutes</td>
          </tr>
        </tbody>
      </table>
      <h2>Other browser storage</h2>
      <p>PartMode uses localStorage and IndexedDB to keep CAD projects, recovery history, application preferences, and first-run state on your device. This storage is necessary for requested local CAD functionality. It is not sent to an advertising or analytics service and remains until you delete projects or clear site data.</p>
      <h2>No optional or third-party tracking</h2>
      <p>There are no analytics, advertising, personalisation, social-media, or third-party tracking cookies. PartMode does not embed Google scripts, frames, or cookies. Google is contacted only after you choose a Google sign-in action and the browser navigates to Google's own domain. No optional script is waiting behind this control. If that changes, PartMode will describe each purpose and provider and ask for a separate opt-in before loading it.</p>
      <h2>Browser controls</h2>
      <p>You can also inspect or delete cookies, localStorage, and IndexedDB in your browser's site-data settings. Deleting local site data can remove locally saved CAD projects, so download important project files first.</p>
      <p>Read the full <a href="/privacy">privacy notice</a>. For a hosted deployment, use the operator's published privacy channel.</p>
    </main>
    <script src="/assets/${assetVersion}/privacy.js" defer></script>
  </body>
</html>
`;
writeFileSync(resolve(distRoot, 'cookies.html'), withBase(BRAND ? cookiesPage(brand, SESSION_COOKIE) : cookiesHtml));

// Keep the executable Node control plane as an exact allowlist. Every module
// copied into the release is also bound by bytes and SHA-256 in release.json.
const runtimeModulePaths = Object.freeze([
  'account-store.js',
  'google-oidc.js',
  'headless-sessions.js',
  'help.js',
  'mcp.js',
  'relay-hub.js',
  'server.js',
  'tokcad-accounts.js',          // TOKCAD: verified email
  'ux-navigation-contract.js',
  'headless/agent-host.js',
  'headless/kernel-host.js',
  'headless/kernel-thread.js',
  'headless/static-hooks.js',
]);
const runtimeModules: AssetEntry[] = runtimeModulePaths.map((path) => {
  const content = readFileSync(resolve(repositoryRoot, '.build', 'src', path));
  const destination = resolve(distRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  return {
    path,
    bytes: content.byteLength,
    sha256: sha256(content),
  };
});
const runtimePackages = ['jose', 'oauth4webapi', 'openid-client', 'nodemailer'].map((name) => {   // TOKCAD: nodemailer
  const source = resolve(repositoryRoot, 'node_modules', name);
  cpSync(source, resolve(distRoot, 'node_modules', name), { recursive: true });
  const metadata = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')) as {
    version?: unknown;
    license?: unknown;
  };
  if (typeof metadata.version !== 'string' || typeof metadata.license !== 'string') {
    throw new Error(`Runtime package ${name} has invalid package metadata.`);
  }
  return { name, version: metadata.version, license: metadata.license };
});
const studioSource = readFileSync(resolve(staticRoot, 'studio.js'));
const release = {
  product: 'PartMode',
  version: productVersion,
  releaseSha: exactReleaseSha,
  assetVersion,
  basePath: BASE_PATH,
  ...(BRAND ? { brand: { name: brand.name, publicUrl: brand.publicUrl, sourceUrl: brand.sourceUrl } } : {}),
  studioSourceSha256: sha256(studioSource),
  help: {
    schema: helpManifest.schema,
    sourceSha256: helpManifest.sourceSha256,
    resources: helpManifest.resources.length,
  },
  runtimeModules,
  runtimePackages,
  assets: assetManifest,
};
writeFileSync(resolve(distRoot, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);

console.log(
  JSON.stringify({
    releaseSha: exactReleaseSha,
    assetVersion,
    assets: assetManifest.length,
    bytes: assetManifest.reduce((total, asset) => total + asset.bytes, 0),
    runtimeModules: runtimeModules.length,
    studioSourceSha256: release.studioSourceSha256,
  }),
);
