// TOKCAD: the TOK CAD branding of a build (TOKCAD_BRAND=1). Upstream pages and scripts are
// built as they are and then rewritten here, so upstream's own checks still run against the
// unbranded build. Only human-readable "PartMode" is renamed: never X-PartMode-CSRF headers,
// storage names, protocol ids, or the kernel's STEP tags (see BRANDED_ASSETS).

export interface BrandContext {
  name: string;               // TOK CAD
  publicUrl: string;          // https://tok-share.com/cad
  repoUrl: string;            // https://github.com/tbarker80/tok-cad
  sourceUrl: string;          // the repository at the exact commit being served
  operator: string;           // who runs the deployment
  contactUrl: string;         // where privacy and other requests go
  assetVersion: string;
  effective: string;          // date of the privacy and cookie pages
}

/** Browser scripts whose visible messages are branded. The kernel worker and drawing exports
 * are left alone: their "PartMode" strings tag files exchanged with other PartMode installs. */
export const BRANDED_ASSETS = Object.freeze(['studio.js', 'account.js', 'studio-cloud-agent-bridge.js']);

// "PartMode" as a word in prose: not inside identifiers such as X-PartMode-CSRF or PartModeAddins.
const PROSE_NAME = /(?<=[\s'"`(>])PartMode(?=[\s.,;:!?'"`)<])/g;

function brandCommon(text: string, ctx: BrandContext): string {
  return text
    .replaceAll('https://partmode.com/mcp', `${ctx.publicUrl}/mcp`)
    .replaceAll('https://github.com/BOMWiki/partmode', ctx.repoUrl)
    .replace(PROSE_NAME, ctx.name);
}

export function brandScript(text: string, ctx: BrandContext): string {
  return brandCommon(text, ctx);
}

export function brandHtml(text: string, ctx: BrandContext): string {
  return brandCommon(
    text
      // social cards pointing at partmode.com images
      .replace(/^\s*<meta (?:property|name)="(?:og|twitter):image"[^>]*>\n/gm, '')
      .replace(/<title>PartMode: [^<]*<\/title>/, `<title>${ctx.name}: parametric CAD in your browser</title>`)
      .replace(/content="PartMode: CLI-native agentic browser CAD"/g, `content="${ctx.name}: parametric CAD in your browser"`)
      .replace('<span class="ws-brand-mark" aria-hidden="true">PM</span>',
        '<span class="ws-brand-mark" aria-hidden="true">TC</span>')
      .replace('<small>V8 · CLI-native agentic CAD</small>', '<small>Parametric CAD in your browser</small>')
      .replaceAll('PM / PartMode', ctx.name)
      .replaceAll('codex mcp add partmode', 'codex mcp add tokcad')
      // the source link the AGPL asks for, beside Help in the studio's status bar
      .replace('<button type="button" id="bw-help-status">Help</button>',
        `<button type="button" id="bw-help-status">Help</button><a href="${ctx.sourceUrl}" rel="noopener">Source</a>`)
      // footers that link to the upstream repository link to this build's source instead
      .replaceAll('>Source</a>', '>Source code</a>'),
    ctx,
  )
    .replaceAll('https://partmode.com/', `${ctx.publicUrl}/`)
    .replaceAll('https://partmode.com', ctx.publicUrl)
    .replaceAll(`href="${ctx.repoUrl}"`, `href="${ctx.sourceUrl}"`);
}

/** The studio page's TOK CAD modules: the start screen (and later the coach and checks). */
export function studioExtras(html: string, ctx: BrandContext): string {
  const asset = (name: string) => `/assets/${ctx.assetVersion}/${name}`;
  return html
    .replace('</head>', `    <link rel="stylesheet" href="${asset('tokcad.css')}" />
  </head>`)
    .replace('</body>', `    <script type="module" src="${asset('tokcad-start.js')}"></script>
    <script type="module" src="${asset('tokcad-coach.js')}"></script>
  </body>`);
}

/** The account page without the options TOK CAD does not offer: Google sign-in and
 * server-headless agent projects. account.js copes with the missing elements. */
export function brandAccountHtml(text: string, ctx: BrandContext): string {
  return brandHtml(
    text
      .replace(/<p class="pm-account-lede">[\s\S]*?<\/p>/,
        `<p class="pm-account-lede">A free ${ctx.name} account is confirmed by email. With it, AI agents you ` +
        'approve can work on a project open in your browser. Saving projects to your account is coming soon.</p>')
      .replace(/\s*<section id="pm-google-auth"[\s\S]*?<\/section>/, '')
      .replace(/\s*<section class="pm-account-panel">\s*<p class="pm-account-kicker">Sign-in methods<\/p>[\s\S]*?<\/section>/, '')
      .replace(/\s*<label class="pm-key-headless">[\s\S]*?<\/label>/, '')
      .replace(/\s*<p><strong>Server-headless durable project:<\/strong>[\s\S]*?<\/p>/, ''),
    ctx,
  );
}

export const COOKIE_BANNER_TEXT = (ctx: BrandContext): string =>
  `${ctx.name} uses essential first-party cookies only: one for this choice and, if you sign in, ` +
  'one for your account session. Projects you model stay on your device. There are no analytics, ' +
  'advertising, or third-party tracking cookies.';

export function markSvg(ctx: BrandContext): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title">
  <title id="title">${ctx.name}</title>
  <rect width="64" height="64" rx="10" fill="#111b26"/>
  <path d="M12 16h26v8h-8.5v24h-9V24H12z" fill="#85bcf4"/>
  <path d="M52 26.5c-1.6-2.4-4-3.6-6.8-3.6-4.6 0-8.2 3.6-8.2 9.1s3.6 9.1 8.2 9.1c2.8 0 5.2-1.2 6.8-3.6l-.1 8.3c-2 1.4-4.5 2.2-7.2 2.2-8.6 0-15.1-6.3-15.1-16s6.5-16 15.1-16c2.7 0 5.2.8 7.3 2.2z" fill="#52769b"/>
</svg>
`;
}

function page(ctx: BrandContext, title: string, description: string, main: string, extraStyle = '', script = ''): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${description}" />
    <title>${title} | ${ctx.name}</title>
    <link rel="icon" href="/assets/${ctx.assetVersion}/partmode-mark.svg" type="image/svg+xml" />
    <style>
      :root { color-scheme: dark; font: 16px/1.65 Inter, ui-sans-serif, system-ui, sans-serif; background: #101318; color: #e9edf2; }
      body { margin: 0; }
      main { width: min(760px, calc(100% - 40px)); margin: 0 auto; padding: 64px 0 96px; }
      a { color: #9fc8ff; }
      h1, h2 { line-height: 1.15; }
      h1 { font-size: clamp(2rem, 6vw, 3.2rem); margin-bottom: 1rem; }
      h2 { margin-top: 2.2rem; }
      .back { display: inline-block; margin-bottom: 2rem; }
      .updated, #pm-cookie-status { color: #aeb7c3; }
      code { color: #c7ddfa; overflow-wrap: anywhere; }
      .legal-nav { display: flex; gap: 16px; flex-wrap: wrap; margin: 2rem 0; }
      ${extraStyle}
    </style>
  </head>
  <body>
    <main>
      <a class="back" href="/">← Back to ${ctx.name}</a>
${main}
      <nav class="legal-nav" aria-label="${ctx.name} pages"><a href="/about">About</a><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a><a href="${ctx.sourceUrl}">Source code</a></nav>
    </main>${script}
  </body>
</html>
`;
}

export function aboutHtml(ctx: BrandContext): string {
  return page(ctx, 'About', `About ${ctx.name}, parametric CAD in your browser.`, `
      <h1>About ${ctx.name}</h1>
      <p>${ctx.name} is parametric 3D CAD that runs in your web browser: constrained sketches, an editable feature history, multiple bodies, assemblies, drawings, and STEP import and export. The geometry kernel runs on your own computer, so your models are not uploaded to model them.</p>
      <p>It is run by ${ctx.operator} at <a href="${ctx.publicUrl}/">${ctx.publicUrl.replace(/^https?:\/\//, '')}</a>.</p>
      <h2>Built on PartMode</h2>
      <p>${ctx.name} is a modified version of <a href="https://github.com/BOMWiki/partmode">PartMode</a> by Sphinx (<a href="https://partmode.com/">partmode.com</a>), used under the <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License v3.0</a>. PartMode is not affiliated with ${ctx.operator} and does not endorse ${ctx.name}.</p>
      <p>As the license requires, the complete source code of the exact version you are using is available: <a href="${ctx.sourceUrl}">${ctx.sourceUrl.replace(/^https?:\/\//, '')}</a>. The changes ${ctx.operator} made are listed in the repository's <code>tokcad/README.md</code>.</p>
      <h2>Other open-source components</h2>
      <ul>
        <li><a href="https://dev.opencascade.org/">Open CASCADE Technology</a>, the geometry kernel, under the GNU LGPL 2.1 with the Open CASCADE exception.</li>
        <li><a href="https://replicad.xyz/">replicad</a> and replicad-opencascadejs, MIT License, by Steve Genoud / QuaroTech.</li>
        <li><a href="https://threejs.org/">three.js</a>, MIT License.</li>
        <li><a href="https://nodemailer.com/">Nodemailer</a> for account email, MIT-0 License.</li>
      </ul>
      <p>The full notices are in the repository's <code>THIRD_PARTY_NOTICES.md</code> and license files.</p>`);
}

export function privacyMain(ctx: BrandContext, cookieName: string): string {
  return `      <h1>Privacy</h1>
      <p class="updated">Effective ${ctx.effective}.</p>
      <p>${ctx.name} is browser CAD. You can model without an account; projects you model stay in your browser's storage on your device unless you download them. This page says what ${ctx.operator}, which runs ${ctx.name} at <code>${ctx.publicUrl.replace(/^https?:\/\//, '')}</code>, stores and why.</p>
      <h2>Who is responsible</h2>
      <p>${ctx.operator}. Contact us through <a href="${ctx.contactUrl}">${ctx.contactUrl.replace(/^https?:\/\//, '')}</a> for any question or request about your data.</p>
      <h2>Accounts</h2>
      <p>An account is optional. If you create one we store your account name, your email address, when the account was created, and whether the email is confirmed. Your passphrase is stored only as a salted scrypt hash; sign-in sessions, email confirmation and password-reset links, and agent keys are stored only as hashes. We use your email address only to confirm it, to send password-reset links you ask for, and to tell you if someone tries to register it again. We do not send newsletters or share your address.</p>
      <p>Account email is sent through Google's Gmail service from ${ctx.operator}'s address, so Google processes those messages under <a href="https://policies.google.com/privacy">Google's privacy policy</a>.</p>
      <h2>Agent keys and the agent relay</h2>
      <p>Signed-in users can create keys that let an AI agent work on a project open in their browser, after approving it there. For each key we store its label, access level, and creation, last-use, expiry and revocation times. Commands and results between the agent and your browser pass through our server in memory only, over HTTPS; they are not stored. ${ctx.name} does not run agent projects on the server.</p>
      <h2>Cookies and browser storage</h2>
      <p>${ctx.name} uses essential first-party cookies only: one remembering your cookie choice and, if you sign in, the session cookie <code>${cookieName}</code>. Your browser's local storage and IndexedDB keep your projects, recovery history and preferences on your device. There are no analytics, advertising or third-party trackers. See <a href="/cookies">cookie details and settings</a>.</p>
      <h2>Server logs</h2>
      <p>Like any website, our web server records each request's IP address, time, requested address and browser type, for security and to fix problems. These logs are not used to profile you and are deleted over time.</p>
      <h2>How long we keep it, and your choices</h2>
      <p>A sign-in session lasts 30 days unless you sign out. Your account data stays until you delete the account from the <a href="/account">account page</a>, which removes the account, its email address, its sessions and its keys at once. Projects in your browser stay until you delete them or clear this site's data. You can ask us at any time what we hold about you, or to correct or delete it.</p>
      <h2>Changes</h2>
      <p>If this page changes we will update the date above.</p>`;
}

export function cookiesMain(ctx: BrandContext, sessionCookie: string): string {
  return `      <h1>Cookie details and settings</h1>
      <p class="updated">Effective ${ctx.effective}.</p>
      <p>${ctx.name} uses no optional cookies: one preference cookie, a session cookie only when you sign in, and essential browser storage for your projects.</p>
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
        <thead><tr><th>Name</th><th>Purpose</th><th>Duration</th></tr></thead>
        <tbody>
          <tr>
            <td data-label="Name"><code>partmode_cookie_consent</code></td>
            <td data-label="Purpose">Remembers that you chose essential storage only, so the notice is not shown again.</td>
            <td data-label="Duration">180 days</td>
          </tr>
          <tr>
            <td data-label="Name"><code>${sessionCookie}</code></td>
            <td data-label="Purpose">Keeps you signed in. Set only when you sign in; Secure and HttpOnly.</td>
            <td data-label="Duration">30 days or until you sign out</td>
          </tr>
        </tbody>
      </table>
      <p>Both are first-party cookies limited to <code>${ctx.publicUrl.replace(/^https?:\/\//, '')}</code>.</p>
      <h2>Other browser storage</h2>
      <p>Local storage and IndexedDB (database <code>partmode-studio</code>) keep your CAD projects, recovery history and preferences on your device. Clearing this site's data in your browser deletes them, so download important projects first.</p>
      <p>Read the full <a href="/privacy">privacy notice</a>.</p>`;
}

export const COOKIES_EXTRA_STYLE = `
      table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
      th, td { padding: 12px; border: 1px solid #3a424d; text-align: left; vertical-align: top; }
      th { background: #171b21; }
      .choice { padding: 18px; border: 1px solid #3a424d; border-radius: 8px; background: #171b21; }
      .choice-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
      button { min-height: 40px; padding: 8px 16px; border: 1px solid #6e7b8c; border-radius: 5px; color: #f5f7fa; background: #262d36; font: inherit; font-weight: 700; cursor: pointer; }
      button[data-cookie-essential] { color: #07121d; background: #a9d1ff; border-color: #a9d1ff; }`;

export function privacyPage(ctx: BrandContext, sessionCookie: string): string {
  return page(ctx, 'Privacy', `How ${ctx.name} handles your data.`, privacyMain(ctx, sessionCookie));
}

export function cookiesPage(ctx: BrandContext, sessionCookie: string): string {
  return page(ctx, 'Cookie settings', `${ctx.name} cookie and browser-storage details and controls.`,
    cookiesMain(ctx, sessionCookie), COOKIES_EXTRA_STYLE,
    `\n    <script src="/assets/${ctx.assetVersion}/privacy.js" defer></script>`);
}
