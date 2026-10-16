import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PARTMODE_UX_NAVIGATION_CONTRACT } from '../src/ux-navigation-contract.js';

interface AssetEntry {
  path: string;
  bytes: number;
  sha256: string;
}

interface ReleaseManifest {
  product: string;
  version: string;
  releaseSha: string;
  assetVersion: string;
  studioSourceSha256: string;
  help: { schema: string; sourceSha256: string; resources: number };
  runtimeModules: AssetEntry[];
  runtimePackages: Array<{ name: string; version: string; license: string }>;
  assets: AssetEntry[];
}

const EXPECTED_RUNTIME_MODULES = Object.freeze([
  'account-store.js',
  'google-oidc.js',
  'headless-sessions.js',
  'help.js',
  'mcp.js',
  'relay-hub.js',
  'server.js',
  'tokcad-accounts.js',          // TOKCAD
  'ux-navigation-contract.js',
  'headless/agent-host.js',
  'headless/kernel-host.js',
  'headless/kernel-thread.js',
  'headless/static-hooks.js',
].sort());

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function listFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const name of readdirSync(resolve(root, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(resolve(root, relative));
    if (stat.isDirectory()) files.push(...listFiles(root, relative));
    else if (stat.isFile()) files.push(relative);
  }
  return files;
}

const distRoot = resolve(process.argv[2] ?? 'dist');
const release = JSON.parse(
  readFileSync(resolve(distRoot, 'release.json'), 'utf8'),
) as ReleaseManifest;
const assetRoot = resolve(distRoot, 'assets', release.assetVersion);
const actualFiles = listFiles(assetRoot);
const expectedFiles = release.assets.map((asset) => asset.path).sort();

if (release.product !== 'PartMode' || !release.version) throw new Error('invalid PartMode release identity');
if (!/^(?:local|[0-9a-f]{40})$/.test(release.releaseSha)) throw new Error('invalid release SHA');
if (!/^[0-9a-f]{16}$/.test(release.assetVersion)) throw new Error('invalid asset version');
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`asset allowlist mismatch\nexpected=${expectedFiles.join(',')}\nactual=${actualFiles.join(',')}`);
}

for (const asset of release.assets) {
  const content = readFileSync(resolve(assetRoot, asset.path));
  if (content.byteLength !== asset.bytes) throw new Error(`${asset.path}: byte count mismatch`);
  if (sha256(content) !== asset.sha256) throw new Error(`${asset.path}: SHA-256 mismatch`);
}

const runtimeModulePaths = release.runtimeModules?.map((module) => module.path).sort();
if (JSON.stringify(runtimeModulePaths) !== JSON.stringify(EXPECTED_RUNTIME_MODULES)) {
  throw new Error(
    `runtime module allowlist mismatch\nexpected=${EXPECTED_RUNTIME_MODULES.join(',')}\nactual=${runtimeModulePaths?.join(',') ?? 'missing'}`,
  );
}
const actualRuntimeModulePaths = [
  ...readdirSync(distRoot)
    .filter((name) => name.endsWith('.js') && statSync(resolve(distRoot, name)).isFile()),
  ...listFiles(resolve(distRoot, 'headless')).map((path) => `headless/${path}`),
].sort();
if (JSON.stringify(actualRuntimeModulePaths) !== JSON.stringify(EXPECTED_RUNTIME_MODULES)) {
  throw new Error(
    `shipped runtime module allowlist mismatch\nexpected=${EXPECTED_RUNTIME_MODULES.join(',')}\nactual=${actualRuntimeModulePaths.join(',')}`,
  );
}
for (const runtimeModule of release.runtimeModules) {
  const content = readFileSync(resolve(distRoot, runtimeModule.path));
  if (content.byteLength !== runtimeModule.bytes) {
    throw new Error(`${runtimeModule.path}: runtime module byte count mismatch`);
  }
  if (sha256(content) !== runtimeModule.sha256) {
    throw new Error(`${runtimeModule.path}: runtime module SHA-256 mismatch`);
  }
}
const helpRuntime = readFileSync(resolve(distRoot, 'help.js'), 'utf8');
if (
  !helpRuntime.includes("from './ux-navigation-contract.js'") ||
  !actualRuntimeModulePaths.includes('ux-navigation-contract.js')
) {
  throw new Error('shipped Help runtime dependency closure is incomplete');
}

const index = readFileSync(resolve(distRoot, 'index.html'), 'utf8');
const help = readFileSync(resolve(distRoot, 'help.html'), 'utf8');
const helpResources = JSON.parse(readFileSync(resolve(distRoot, 'help-resources.json'), 'utf8')) as {
  schema?: unknown;
  sourceSha256?: unknown;
  releaseSha?: unknown;
  navigation?: unknown;
  resources?: Array<{ uri?: unknown; text?: unknown }>;
};
const helpResourceEntries = helpResources.resources ?? [];
const agentHelp = helpResourceEntries.find((resource) => resource.uri === 'partmode://help/agent-workflow');
const expectedHelpSourceHash = createHash('sha256');
expectedHelpSourceHash.update(PARTMODE_UX_NAVIGATION_CONTRACT.schema);
expectedHelpSourceHash.update('\0');
expectedHelpSourceHash.update(JSON.stringify(PARTMODE_UX_NAVIGATION_CONTRACT.paths));
expectedHelpSourceHash.update('\0');
for (const resource of helpResourceEntries) {
  if (typeof resource.uri !== 'string' || typeof resource.text !== 'string') continue;
  expectedHelpSourceHash.update(resource.uri);
  expectedHelpSourceHash.update('\0');
  expectedHelpSourceHash.update(resource.text);
  expectedHelpSourceHash.update('\0');
}
const expectedHelpSourceSha256 = expectedHelpSourceHash.digest('hex');
const account = readFileSync(resolve(distRoot, 'account.html'), 'utf8');
const about = readFileSync(resolve(distRoot, 'about.html'), 'utf8');
const privacy = readFileSync(resolve(distRoot, 'privacy.html'), 'utf8');
const cookies = readFileSync(resolve(distRoot, 'cookies.html'), 'utf8');
const server = readFileSync(resolve(distRoot, 'server.js'), 'utf8');
const privacyScript = readFileSync(resolve(assetRoot, 'privacy.js'), 'utf8');
const expectedPrefix = `/assets/${release.assetVersion}/`;
if (index.includes('/static/')) throw new Error('index still references the legacy /static asset namespace');
if (account.includes('/static/')) throw new Error('account page still references /static assets');
if (help.includes('/static/')) throw new Error('help page still references the legacy /static asset namespace');
if (about.includes('/static/')) throw new Error('about page still references /static assets');
if (!index.includes(expectedPrefix + 'studio.js')) throw new Error('index does not load versioned Studio');
if (
  !index.includes('id="pm-agent-access"') ||
  !index.includes('>Sign in</span>') ||
  !account.includes(expectedPrefix + 'account.js') ||
  !account.includes(expectedPrefix + 'account.css') ||
  !account.includes('id="pm-key-secret"') ||
  !account.includes('id="pm-google-signin"') ||
  !account.includes('id="pm-google-note"') ||
  !account.includes('id="pm-google-link"') ||
  !account.includes('id="pm-google-unlink"') ||
  !account.includes('/auth/google/start') ||
  !account.includes('not your email') ||
  !account.includes('Sign in or create an account') ||
  !account.includes('https://partmode.com/mcp') ||
  !account.includes('--bearer-token-env-var PARTMODE_AGENT_KEY') ||
  !account.includes('href="/help#agents"') ||
  !account.includes('partmode_headless_open') ||
  !account.includes('full document JSON') ||
  !account.includes('deletes all durable server-headless project records')
) {
  throw new Error('agent account onboarding surfaces are incomplete');
}
if (
  !help.includes('<title>Help | PartMode</title>') ||
  !help.includes('One model.') ||
  !help.includes('PartMode is free to use and is intended to remain free') ||
  !help.includes('href="/about"') ||
  !help.includes('>Sphinx</a>') ||
  !help.includes('partmode://help/agent-workflow') ||
  helpResources.schema !== 'partmode.help/v1' ||
  helpResources.releaseSha !== release.releaseSha ||
  helpResources.sourceSha256 !== release.help.sourceSha256 ||
  helpResources.sourceSha256 !== expectedHelpSourceSha256 ||
  JSON.stringify(helpResources.navigation) !== JSON.stringify(PARTMODE_UX_NAVIGATION_CONTRACT) ||
  helpResourceEntries.length !== release.help.resources ||
  release.help.resources !== 4 ||
  typeof agentHelp?.text !== 'string' ||
  !agentHelp.text.includes('partmode_headless_open') ||
  !agentHelp.text.includes('partmode_headless_export_step') ||
  !agentHelp.text.includes('cad_artifact') ||
  !agentHelp.text.includes('full document JSON') ||
  help.includes('{{') ||
  help.includes('}}') ||
  !helpResourceEntries.every((resource) =>
    typeof resource.uri === 'string' && resource.uri.startsWith('partmode://help/') &&
    typeof resource.text === 'string' && resource.text.length > 100 &&
    !resource.text.includes('{{') && !resource.text.includes('}}'))
) {
  throw new Error('release-versioned human and agent Help is incomplete');
}
if (
  !about.includes('<title>About | PartMode</title>') ||
  !about.includes('<link rel="canonical" href="https://partmode.com/about"') ||
  !about.includes(`content="${release.releaseSha}"`) ||
  !about.includes('PartMode is free to use and is intended to remain free') ||
  !about.includes('<a href="https://x.com/protosphinx" rel="me noopener">Sphinx</a>') ||
  !about.includes("Sphinx's interests include software, manufacturing, and how practical knowledge becomes repeatable work") ||
  !about.includes('href="/help"') ||
  /(?:founder|>\s*@protosphinx\s*<)/iu.test(about)
) {
  throw new Error('public About identity or product context is incomplete');
}
if (/(?:founder|>\s*@protosphinx\s*<)/iu.test(`${index}\n${help}\n${about}`)) {
  throw new Error('private creator identity leaked into a public product surface');
}
if (
  !index.includes('id="pm-cookie-banner"') ||
  !index.includes('data-cookie-essential') ||
  !index.includes('id="bw-help-about"') ||
  !index.includes('href="/about"') ||
  !index.includes('href="/privacy"') ||
  !index.includes('href="/cookies"')
) {
  throw new Error('privacy notice is missing from the product shell');
}
if (
  !privacy.includes('does not use analytics') ||
  !privacy.includes('separate, informed opt-in choice') ||
  !privacy.includes('Cloudflare') ||
  !privacy.includes('does not retain Google') ||
  !privacy.includes('Google\'s privacy policy') ||
  !privacy.includes('data-protection authority') ||
  !privacy.includes('Effective 2 August 2026') ||
  !privacy.includes('per-key consent') ||
  !privacy.includes('full document JSON') ||
  !privacy.includes('Those records remain until account deletion') ||
  !privacy.includes('Deleting the account closes active headless sessions')
) {
  throw new Error('privacy policy does not preserve the no-tracking boundary');
}
if (
  !cookies.includes('<code>partmode_cookie_consent</code>') ||
  !cookies.includes('<code>__Host-partmode_account</code>') ||
  !cookies.includes('<code>__Host-partmode_oidc</code>') ||
  !cookies.includes('Strictly necessary preference') ||
  !cookies.includes('Up to 10 minutes') ||
  !cookies.includes('180 days') ||
  !cookies.includes('Forget my cookie choice') ||
  !cookies.includes('There are no analytics, advertising, personalisation')
) {
  throw new Error('cookie inventory and controls are incomplete');
}
const expectedRuntimePackages = [
  { name: 'jose', version: '6.2.6', license: 'MIT' },
  { name: 'oauth4webapi', version: '3.8.6', license: 'MIT' },
  { name: 'openid-client', version: '6.8.4', license: 'MIT' },
  { name: 'nodemailer', version: '7.0.13', license: 'MIT-0' },   // TOKCAD: verification mail
];
if (JSON.stringify(release.runtimePackages) !== JSON.stringify(expectedRuntimePackages)) {
  throw new Error('locked OIDC runtime package metadata is incomplete');
}
for (const runtimePackage of expectedRuntimePackages) {
  if (
    !statSync(resolve(distRoot, 'node_modules', runtimePackage.name, 'package.json')).isFile() ||
    // TOKCAD: nodemailer ships LICENSE, not LICENSE.md
    !['LICENSE.md', 'LICENSE'].some((file) =>
      statSync(resolve(distRoot, 'node_modules', runtimePackage.name, file), { throwIfNoEntry: false })?.isFile())
  ) {
    throw new Error(`runtime package is incomplete: ${runtimePackage.name}`);
  }
}
if (
  !privacyScript.includes("const COOKIE_VALUE = 'essential-v1'") ||
  !privacyScript.includes('Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax') ||
  !privacyScript.includes("window.location.protocol === 'https:' ? '; Secure' : ''")
) {
  throw new Error('cookie persistence attributes are incomplete');
}
if (
  /\b(?:gtag|google-analytics|googletagmanager|mixpanel|segment\.com|plausible\.io)\b/i.test(
    `${index}\n${help}\n${about}\n${privacy}\n${cookies}\n${privacyScript}`,
  )
) {
  throw new Error('tracking code detected in product HTML');
}
if (!server.includes('max-age=31536000, immutable')) {
  throw new Error('server does not mark fingerprinted assets immutable');
}
if (!server.includes('max-age=0, must-revalidate')) {
  throw new Error('server does not revalidate HTML immediately');
}
if (
  !server.includes("path === '/help'") ||
  !server.includes("path === '/about'") ||
  !server.includes("path === '/api/v1/help'")
) {
  throw new Error('server does not expose Help, About, and agent Help routes');
}
if (!/^[0-9a-f]{64}$/.test(release.studioSourceSha256)) {
  throw new Error('release does not record the Studio source SHA-256');
}
console.log(
  `PartMode integrity OK: ${release.assets.length} assets, ${release.runtimeModules.length} runtime modules, version ${release.assetVersion}, release ${release.releaseSha}`,
);
