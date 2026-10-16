import { createHash, randomBytes } from 'node:crypto';   // TOKCAD: createHash for the studio CSP
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AccountStore,
  AccountStoreError,
  type AgentKey,
  type WebSession,
} from './account-store.js';
import {
  GOOGLE_AUTH_TRANSACTION_TTL_MS,
  GoogleAuthError,
  GoogleAuthService,
} from './google-oidc.js';
import { HeadlessSessionManager } from './headless-sessions.js';
import type { PartModeHelpManifest } from './help.js';
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';
import {
  alreadyRegisteredMessage, Mailer, normalizeEmail, resetMessage, TokcadAccounts, verifyMessage,
} from './tokcad-accounts.js';
import {
  isMoldSessionId, MOLD_ANALYSES_PER_HOUR, MOLD_STEP_LIMIT, MOLD_UPLOADS_PER_HOUR, MoldService, MoldServiceError,
} from './tokcad-mold.js';
import { RelayError, RelayHub, type AgentIdentity } from './relay-hub.js';

export interface ReleaseFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  product: 'PartMode';
  version: string;
  releaseSha: string;
  assetVersion: string;
  basePath?: string;             // TOKCAD: path prefix, '' or absent at the root
  brand?: { name: string; publicUrl: string; sourceUrl: string };   // TOKCAD: branded build
  studioSourceSha256: string;
  help: {
    schema: 'partmode.help/v1';
    sourceSha256: string;
    resources: number;
  };
  runtimeModules: ReleaseFileEntry[];
}

export interface PartModeServerOptions {
  distDir?: string;
  host?: string;
  port?: number;
  stateDir?: string;
  publicOrigin?: string;
  googleAuth?: GoogleAuthService | null;
}

export interface RunningPartModeServer {
  server: Server;
  url: string;
  release: ReleaseManifest;
  /** Stop accepting requests and await headless worker/resource disposal. */
  close(): Promise<void>;
}

interface ApiContext {
  store: AccountStore;
  tokcad: { accounts: TokcadAccounts; mailer: Mailer; mold: MoldService };   // TOKCAD: verified email, molding check
  relay: RelayHub;
  headless: HeadlessSessionManager;
  release: ReleaseManifest;
  help: PartModeHelpManifest;
  publicOrigin?: string;
  googleAuth: GoogleAuthService | null;
  authLimiter: FixedWindowLimiter;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly allow: string | undefined;

  constructor(status: number, code: string, message: string, allow?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.allow = allow;
  }
}

class FixedWindowLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();
  readonly #maxEntries: number;
  #nextPruneAt = 0;

  constructor(maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('FixedWindowLimiter maxEntries must be a positive integer.');
    }
    this.#maxEntries = maxEntries;
  }

  take(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    if (now >= this.#nextPruneAt) {
      for (const [entryKey, entry] of this.#entries) {
        if (entry.resetAt <= now) this.#entries.delete(entryKey);
      }
      this.#nextPruneAt = now + Math.min(windowMs, 60_000);
    }
    let current = this.#entries.get(key);
    if (current && current.resetAt <= now) {
      this.#entries.delete(key);
      current = undefined;
    }
    if (!current) {
      if (this.#entries.size >= this.#maxEntries) return false;
      this.#entries.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }
}

class AuthWorkLimiter {
  readonly #maxActive: number;
  #active = 0;

  constructor(maxActive: number) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new TypeError('AuthWorkLimiter maxActive must be a positive integer.');
    }
    this.#maxActive = maxActive;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maxActive) {
      throw new HttpError(
        503,
        'AUTH_BUSY',
        'PartMode is handling the maximum number of account security checks. Try again shortly.',
      );
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
});

const ACCOUNT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

const API_BODY_LIMIT = 64 * 1024;
const STUDIO_BODY_LIMIT = 640 * 1024;
const MCP_BODY_LIMIT = 768 * 1024;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_ATTEMPT_LIMIT = 20;
const AUTH_WORK_LIMITER = new AuthWorkLimiter(8);

function commonHeaders(): Record<string, string> {
  return {
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  cacheControl: string,
  extraHeaders: Record<string, string | string[]> = {},
): void {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    ...commonHeaders(),
    'content-type': contentType,
    'content-length': String(content.byteLength),
    'cache-control': cacheControl,
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

// TOKCAD: the studio page's Content-Security-Policy in a branded build. The page carries inline
// scripts (the first-visit welcome sequence), so the policy allows exactly those by hash, worked
// out from the page being served: an upstream edit to the script cannot silently break it.
// nginx sets the policy for every other /cad page and leaves this one to the app.
let studioCsp = '';

function studioCspFor(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)]
    // the browser hashes the script after HTML parsing, which turns CRLF and CR into LF
    .map((m) => (m[1] ?? '').replace(/\r\n?/g, '\n'))
    .map((text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

// TOKCAD: a branded build's name in the messages people read ('' when unbranded).
let brandName = '';
let brandPublicUrl = '';

function brandMessage(value: unknown): unknown {
  if (!brandName || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string'
    ? { ...value, message: message.replace(/\bPartMode\b/g, brandName) }
    : value;
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string | string[]> = {},
): void {
  send(
    req,
    res,
    status,
    'application/json; charset=utf-8',
    status === 204 ? '' : `${JSON.stringify(brandMessage(value))}\n`,
    'no-store',
    extraHeaders,
  );
}

// TOKCAD: path prefix the app is served under (see scripts/build.ts); '' when at the root.
let basePath = '';

function redirect(req: IncomingMessage, res: ServerResponse, location: string): void {
  location = location.startsWith('/') ? `${basePath}${location}` : location;
  const body = `Redirecting to ${location}\n`;
  res.writeHead(308, {
    ...commonHeaders(),
    location,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'public, max-age=300',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function temporaryRedirect(
  req: IncomingMessage,
  res: ServerResponse,
  status: 302 | 303,
  location: string,
  extraHeaders: Record<string, string | string[]> = {},
): void {
  const body = `Redirecting to ${location}\n`;
  res.writeHead(status, {
    ...commonHeaders(),
    location,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function safeAssetPath(assetRoot: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\\') || decoded.split('/').includes('..')) return null;
  const candidate = resolve(assetRoot, decoded);
  return candidate.startsWith(`${assetRoot}${sep}`) ? candidate : null;
}

function serveAsset(req: IncomingMessage, res: ServerResponse, file: string): void {
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    send(req, res, 404, 'text/plain; charset=utf-8', 'Not found\n', 'no-store');
    return;
  }

  res.writeHead(200, {
    ...commonHeaders(),
    'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(size),
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function isSecureRequest(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
  return protocol === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

function requestOrigin(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (!host || /[\s/\\]/.test(host)) return null;
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

function exactOriginRequired(req: IncomingMessage, configured?: string): void {
  const expected = configured ?? requestOrigin(req);
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if (!expected || typeof origin !== 'string' || origin !== expected) {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'This request must come from the PartMode origin.');
  }
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-site account requests are not allowed.');
  }
}

function optionalMcpOrigin(req: IncomingMessage, configured?: string): void {
  if (req.headers.origin === undefined) return;
  exactOriginRequired(req, configured);
}

function requireJson(req: IncomingMessage): void {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  requireJson(req);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The JSON request body is too large.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The JSON request body is too large.');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new HttpError(400, 'JSON_REQUIRED', 'A JSON request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'JSON_INVALID', 'The request body is not valid JSON.');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'JSON_OBJECT_REQUIRED', 'The JSON request body must be an object.');
  }
  return value as Record<string, unknown>;
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  const raw = req.headers.cookie;
  if (!raw || raw.length > 8192) return result;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) result.set(name, value);
  }
  return result;
}

// A __Host- cookie must have Path=/, so under a prefix the session uses __Secure- scoped to it.
function cookiePath(): string {
  return basePath || '/';
}

function sessionCookieName(req: IncomingMessage): string {
  if (basePath) return isSecureRequest(req) ? '__Secure-partmode_account' : 'partmode_account_dev';
  return isSecureRequest(req) ? '__Host-partmode_account' : 'partmode_account_dev';
}

function sessionCookie(req: IncomingMessage, token: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return [
    `${sessionCookieName(req)}=${token}`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(isSecureRequest(req) ? ['Secure'] : []),
  ].join('; ');
}

function clearSessionCookie(req: IncomingMessage): string {
  return [
    `${sessionCookieName(req)}=`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(isSecureRequest(req) ? ['Secure'] : []),
  ].join('; ');
}

function googleBindingCookieName(req: IncomingMessage): string {
  if (basePath) return isSecureRequest(req) ? '__Secure-partmode_oidc' : 'partmode_oidc_dev';
  return isSecureRequest(req) ? '__Host-partmode_oidc' : 'partmode_oidc_dev';
}

function googleBindingCookie(req: IncomingMessage, value: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.min(
    Math.floor(GOOGLE_AUTH_TRANSACTION_TTL_MS / 1_000),
    Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000),
  ));
  return [
    `${googleBindingCookieName(req)}=${value}`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(isSecureRequest(req) ? ['Secure'] : []),
  ].join('; ');
}

function clearGoogleBindingCookie(req: IncomingMessage): string {
  return [
    `${googleBindingCookieName(req)}=`,
    `Path=${cookiePath()}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(isSecureRequest(req) ? ['Secure'] : []),
  ].join('; ');
}

function googleCallbackUri(req: IncomingMessage, configuredOrigin?: string): string {
  const origin = configuredOrigin ?? requestOrigin(req);
  if (!origin) throw new HttpError(400, 'REQUEST_ORIGIN_INVALID', 'PartMode could not determine the callback origin.');
  return new URL('/auth/google/callback', origin).href;
}

function absoluteRequestUrl(req: IncomingMessage, configuredOrigin?: string): URL {
  const origin = configuredOrigin ?? requestOrigin(req);
  if (!origin) throw new HttpError(400, 'REQUEST_ORIGIN_INVALID', 'PartMode could not determine the request origin.');
  return new URL(req.url ?? '/', origin);
}

function webSession(req: IncomingMessage, store: AccountStore): { rawToken: string; session: WebSession } | null {
  const rawToken = parseCookies(req).get(sessionCookieName(req));
  if (!rawToken) return null;
  const session = store.getWebSession(rawToken);
  return session ? { rawToken, session } : null;
}

function requireWebSession(req: IncomingMessage, store: AccountStore): { rawToken: string; session: WebSession } {
  const authenticated = webSession(req, store);
  if (!authenticated) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to manage this PartMode account.');
  return authenticated;
}

function requireCsrf(req: IncomingMessage, session: WebSession): void {
  const token = req.headers['x-partmode-csrf'];
  if (typeof token !== 'string' || token !== session.csrfToken) {
    throw new HttpError(403, 'CSRF_REJECTED', 'The account security token is missing or invalid.');
  }
}

function publicAgentKey(key: AgentKey): Record<string, unknown> {
  return {
    id: key.id,
    label: key.label,
    access: key.access,
    headless: key.headless,
    prefix: `pmak_v1_${key.id}_...`,
    grantCeiling: key.grantCeiling,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  };
}

function signedOutAccountPayload(context: ApiContext): Record<string, unknown> {
  return {
    authenticated: false,
    authMethods: {
      google: { enabled: context.googleAuth !== null, linked: false, canLink: false, canUnlink: false },
    },
  };
}

function accountPayload(context: ApiContext, session: WebSession): Record<string, unknown> {
  const identities = context.store.listExternalIdentities(session.account.id);
  const googleLinked = identities.some((identity) => identity.provider === 'google');
  return {
    authenticated: true,
    csrfToken: session.csrfToken,
    account: session.account,
    email: context.tokcad.accounts.byAccount(session.account.id)?.email ?? null,   // TOKCAD
    authMethods: {
      passphrase: session.account.hasPassphrase,
      google: {
        enabled: context.googleAuth !== null,
        linked: googleLinked,
        canLink: context.googleAuth !== null && !googleLinked,
        canUnlink: googleLinked && (session.account.hasPassphrase || identities.length > 1),
      },
    },
    identities,
    keys: context.store.listAgentKeys(session.account.id).map(publicAgentKey),
  };
}

function agentIdentity(req: IncomingMessage, store: AccountStore): AgentIdentity {
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string' ? authorization.match(/^Bearer (pmak_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43})$/) : null;
  if (!match?.[1]) throw new HttpError(401, 'INVALID_AGENT_KEY', 'A valid PartMode agent key is required.');
  const authenticated = store.authenticateAgentKey(match[1]);
  if (!authenticated) throw new HttpError(401, 'INVALID_AGENT_KEY', 'The PartMode agent key is invalid, expired, or revoked.');
  return {
    accountId: authenticated.account.id,
    keyId: authenticated.key.id,
    keyLabel: authenticated.key.label,
    access: authenticated.key.access,
    headless: authenticated.key.headless,
    grantCeiling: [...authenticated.key.grantCeiling.granted],
  };
}

function authRateKey(req: IncomingMessage, route: string): string {
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  const normalizedRemote = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  const remoteIsLoopback =
    normalizedRemote === '::1' ||
    (isIP(normalizedRemote) === 4 && normalizedRemote.startsWith('127.'));
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = remoteIsLoopback && typeof forwarded === 'string'
    ? forwarded.split(',')[0]?.trim()
    : undefined;
  const clientAddress = forwardedIp && isIP(forwardedIp) !== 0
    ? forwardedIp
    : remoteAddress;
  return `${clientAddress}:${route}`;
}

function requireMethod(req: IncomingMessage, methods: readonly string[]): void {
  if (!req.method || !methods.includes(req.method)) {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', methods.join(', '));
  }
}

// ── TOKCAD: email verification and password reset ───────────────────────────────────────────
/** TOKCAD_EMAIL_VERIFICATION=off restores upstream signup for upstream's smoke tests. */
function emailVerification(): boolean {
  return process.env.TOKCAD_EMAIL_VERIFICATION !== 'off';
}

const EMAIL_SEND_LIMIT = 4;                     // mails to one address per window
const EMAIL_SEND_WINDOW_MS = 60 * 60 * 1000;

function appUrl(req: IncomingMessage, context: ApiContext, path: string): string {
  const origin = context.publicOrigin ?? requestOrigin(req);
  if (!origin) throw new HttpError(400, 'REQUEST_ORIGIN_INVALID', 'Could not determine this site\'s address.');
  return `${origin}${basePath}${path}`;
}

function takeEmailLimit(context: ApiContext, email: string): void {
  if (!context.authLimiter.take(`email:${email}`, EMAIL_SEND_LIMIT, EMAIL_SEND_WINDOW_MS)) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many emails to that address. Try again in an hour.');
  }
}

async function sendMail(context: ApiContext, message: Parameters<Mailer['send']>[0]): Promise<void> {
  try {
    await context.tokcad.mailer.send(message);
  } catch (error) {
    console.error(`TOK CAD mail to ${message.to} failed:`, error instanceof Error ? error.message : error);
    throw new HttpError(503, 'MAIL_FAILED', 'The email could not be sent. Try again in a few minutes.');
  }
}

async function sendVerification(
  req: IncomingMessage, context: ApiContext, accountId: string, name: string, email: string,
): Promise<void> {
  const token = context.tokcad.accounts.createToken(accountId, 'verify');
  const link = appUrl(req, context, `/api/v1/email/verify?token=${token}`);
  await sendMail(context, verifyMessage(email, name, link));
}

/** A no-store redirect to a page of this app (verification links must not be cached). */
function appRedirect(res: ServerResponse, path: string, cookie?: string): void {
  res.writeHead(303, {
    ...commonHeaders(),
    location: `${basePath}${path}`,
    'cache-control': 'no-store',
    ...(cookie ? { 'set-cookie': cookie } : {}),
  });
  res.end();
}

// ── TOKCAD: the molding check (see tokcad-mold.ts) ──────────────────────────────────────────
const MOLD_WINDOW_MS = 60 * 60 * 1000;

async function readStepBody(req: IncomingMessage): Promise<Buffer> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^(application\/octet-stream|application\/step|model\/step)(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'STEP_REQUIRED', 'Send the part as a STEP file.');
  }
  const tooLarge = () => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The part is too large for the molding check (50 MB at most).');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MOLD_STEP_LIMIT) throw tooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > MOLD_STEP_LIMIT) throw tooLarge();
    chunks.push(chunk);
  }
  if (bytes === 0) throw new HttpError(400, 'STEP_REQUIRED', 'Send the part as a STEP file.');
  return Buffer.concat(chunks);
}

/** Signed in, with a verified email (the check stores the part for 7 days). */
function requireMoldUser(req: IncomingMessage, context: ApiContext): string {
  exactOriginRequired(req, context.publicOrigin);
  const authenticated = webSession(req, context.store);
  if (!authenticated) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Create a free account (or sign in) to run the molding check.');
  }
  requireCsrf(req, authenticated.session);
  const accountId = authenticated.session.account.id;
  if (emailVerification() && !context.tokcad.accounts.isVerified(accountId)) {
    throw new HttpError(403, 'EMAIL_UNVERIFIED', 'Verify your email address to run the molding check.');
  }
  return accountId;
}

async function handleTokcadMoldApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: ApiContext,
): Promise<void> {
  const mold = context.tokcad.mold;
  try {
    if (path === '/api/v1/mold/status') {
      requireMethod(req, ['GET']);
      const signedIn = webSession(req, context.store);
      const verified = signedIn !== null
        && (!emailVerification() || context.tokcad.accounts.isVerified(signedIn.session.account.id));
      sendJson(req, res, 200, { available: mold.enabled, signedIn: signedIn !== null, verified });
      return;
    }
    if (path === '/api/v1/mold/sessions') {
      requireMethod(req, ['POST']);
      const accountId = requireMoldUser(req, context);
      if (!context.authLimiter.take(`mold-upload:${accountId}`, MOLD_UPLOADS_PER_HOUR, MOLD_WINDOW_MS)) {
        throw new HttpError(429, 'RATE_LIMITED', 'That is a lot of molding checks for one hour. Try again later.');
      }
      const step = await readStepBody(req);
      sendJson(req, res, 200, await mold.createSession(accountId, step));
      return;
    }
    const match = /^\/api\/v1\/mold\/sessions\/([^/]+)\/analyze$/.exec(path);
    if (match) {
      requireMethod(req, ['POST']);
      const accountId = requireMoldUser(req, context);
      if (!isMoldSessionId(match[1]!)) throw new HttpError(404, 'NOT_FOUND', 'Unknown or expired molding check.');
      const body = objectBody(await readJson(req, API_BODY_LIMIT));
      let pull: [number, number, number] | null = null;
      if (body.pull !== undefined && body.pull !== null) {
        const p = body.pull;
        if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => typeof c === 'number' && Number.isFinite(c))
            || p.every((c) => Math.abs(c as number) < 1e-9)) {
          throw new HttpError(400, 'PULL_INVALID', 'The pull direction must be [x, y, z].');
        }
        pull = p as [number, number, number];
      }
      if (!context.authLimiter.take(`mold-analyze:${accountId}`, MOLD_ANALYSES_PER_HOUR, MOLD_WINDOW_MS)) {
        throw new HttpError(429, 'RATE_LIMITED', 'That is a lot of molding checks for one hour. Try again later.');
      }
      sendJson(req, res, 200, await mold.analyze(accountId, match[1]!, pull));
      return;
    }
    throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    if (error instanceof MoldServiceError) throw new HttpError(error.status, 'MOLD_CHECK_FAILED', error.message);
    throw error;
  }
}

async function handleTokcadAccountApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: ApiContext,
): Promise<boolean> {
  const { store } = context;
  const accounts = context.tokcad.accounts;

  // The link in the verification email: verify, sign in, and land on the account page.
  if (path === '/api/v1/email/verify') {
    requireMethod(req, ['GET']);
    const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
    const accountId = accounts.consumeToken(token, 'verify');
    if (!accountId) {
      appRedirect(res, '/account?verify=invalid');
      return true;
    }
    accounts.markVerified(accountId);
    const created = store.createWebSession(accountId);
    appRedirect(res, '/account?verify=ok', sessionCookie(req, created.token, created.expiresAt));
    return true;
  }

  // Send a new verification link. Same reply whatever the address, to avoid probing.
  if (path === '/api/v1/email/resend') {
    requireMethod(req, ['POST']);
    exactOriginRequired(req, context.publicOrigin);
    if (!context.authLimiter.take(authRateKey(req, 'email-resend'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    }
    const body = objectBody(await readJson(req, API_BODY_LIMIT));
    const email = normalizeEmail(body.email);
    const found = email ? accounts.byEmail(email) : null;
    if (email && found && !found.verified) {
      takeEmailLimit(context, email);
      await sendVerification(req, context, found.accountId, found.name, email);
    }
    sendJson(req, res, 200, { sent: true });
    return true;
  }

  // Forgot password: a reset link to a verified address (an unverified one gets its
  // verification link instead). Same reply whatever the address.
  if (path === '/api/v1/password/forgot') {
    requireMethod(req, ['POST']);
    exactOriginRequired(req, context.publicOrigin);
    if (!context.authLimiter.take(authRateKey(req, 'password-forgot'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    }
    const body = objectBody(await readJson(req, API_BODY_LIMIT));
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'EMAIL_INVALID', 'Enter a valid email address.');
    const found = accounts.byEmail(email);
    if (found) {
      takeEmailLimit(context, email);
      if (found.verified) {
        const token = accounts.createToken(found.accountId, 'reset');
        await sendMail(context, resetMessage(email, found.name, appUrl(req, context, `/account?reset=${token}`)));
      } else {
        await sendVerification(req, context, found.accountId, found.name, email);
      }
    }
    sendJson(req, res, 200, { sent: true });
    return true;
  }

  // Set a new password with the token from the reset email; every session is signed out.
  if (path === '/api/v1/password/reset') {
    requireMethod(req, ['POST']);
    exactOriginRequired(req, context.publicOrigin);
    if (!context.authLimiter.take(authRateKey(req, 'password-reset'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    }
    const body = objectBody(await readJson(req, API_BODY_LIMIT));
    if (typeof body.password !== 'string') throw new HttpError(400, 'PASSWORD_INVALID', 'Enter a new password.');
    const accountId = accounts.consumeToken(body.token, 'reset');
    if (!accountId) {
      throw new HttpError(400, 'RESET_LINK_INVALID', 'That reset link has expired or was already used. Ask for a new one.');
    }
    await AUTH_WORK_LIMITER.run(() => store.setPassword(accountId, body.password as string));
    store.revokeAllWebSessions(accountId);
    accounts.markVerified(accountId);           // the link proved the address
    sendJson(req, res, 200, { reset: true, authenticated: false }, { 'set-cookie': clearSessionCookie(req) });
    return true;
  }
  return false;
}

async function handleAccountApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: ApiContext,
): Promise<void> {
  const { store, relay } = context;

  if (path.startsWith('/api/v1/mold/')) return handleTokcadMoldApi(req, res, path, context);   // TOKCAD
  if (await handleTokcadAccountApi(req, res, path, context)) return;   // TOKCAD

  if (path === '/api/v1/account' && req.method === 'GET') {
    const authenticated = webSession(req, store);
    sendJson(req, res, 200, authenticated ? accountPayload(context, authenticated.session) : signedOutAccountPayload(context));
    return;
  }

  if (path === '/api/v1/auth/google/link') {
    requireMethod(req, ['POST']);
    exactOriginRequired(req, context.publicOrigin);
    const googleAuth = context.googleAuth;
    if (!googleAuth) throw new HttpError(503, 'GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is not configured.');
    const authenticated = requireWebSession(req, store);
    requireCsrf(req, authenticated.session);
    objectBody(await readJson(req, API_BODY_LIMIT));
    if (!context.authLimiter.take(authRateKey(req, 'google-link'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many Google link attempts. Try again later.');
    }
    const started = await googleAuth.begin(
      'link',
      googleCallbackUri(req, context.publicOrigin),
      authenticated.session.account.id,
    );
    sendJson(req, res, 200, {
      authorizationUrl: started.authorizationUrl.href,
      expiresAt: started.expiresAt,
    }, {
      'set-cookie': googleBindingCookie(req, started.browserBinding, started.expiresAt),
    });
    return;
  }

  if (path === '/api/v1/identities/google') {
    requireMethod(req, ['DELETE']);
    exactOriginRequired(req, context.publicOrigin);
    requireJson(req);
    const authenticated = requireWebSession(req, store);
    requireCsrf(req, authenticated.session);
    const removed = store.unlinkExternalIdentity(authenticated.session.account.id, 'google');
    if (!removed) throw new HttpError(404, 'GOOGLE_IDENTITY_NOT_FOUND', 'Google is not connected to this account.');
    store.revokeAllWebSessions(authenticated.session.account.id);
    const created = store.createWebSession(authenticated.session.account.id);
    const session = store.getWebSession(created.token);
    if (!session) throw new Error('Rotated account session was not persisted.');
    sendJson(req, res, 200, accountPayload(context, session), {
      'set-cookie': sessionCookie(req, created.token, created.expiresAt),
    });
    return;
  }

  if (path === '/api/v1/accounts') {
    requireMethod(req, ['POST']);
    exactOriginRequired(req, context.publicOrigin);
    if (!context.authLimiter.take(authRateKey(req, 'signup'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many account attempts. Try again later.');
    }
    const body = objectBody(await readJson(req, API_BODY_LIMIT));
    if (!emailVerification()) {
      // TOKCAD: upstream behavior, for upstream's own smoke tests only (refused in production)
      const account = await AUTH_WORK_LIMITER.run(
        () => store.createAccount(body.name as string, body.password as string),
      );
      const created = store.createWebSession(account.id);
      const session = store.getWebSession(created.token);
      if (!session) throw new Error('New account session was not persisted.');
      sendJson(req, res, 201, accountPayload(context, session), {
        'set-cookie': sessionCookie(req, created.token, created.expiresAt),
      });
      return;
    }
    // TOKCAD: an account needs a verified email before it can sign in. The reply is the same
    // whether or not the address is already registered, so it cannot be used to probe for
    // accounts; the owner of a registered address is told by email instead.
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'EMAIL_INVALID', 'Enter a valid email address.');
    takeEmailLimit(context, email);
    const existing = context.tokcad.accounts.byEmail(email);
    if (existing) {
      await sendMail(context, alreadyRegisteredMessage(email, existing.name, appUrl(req, context, '/account')));
      sendJson(req, res, 201, { authenticated: false, verificationSent: true });
      return;
    }
    const account = await AUTH_WORK_LIMITER.run(
      () => store.createAccount(body.name as string, body.password as string),
    );
    context.tokcad.accounts.addEmail(account.id, account.name, email);
    await sendVerification(req, context, account.id, account.name, email);
    sendJson(req, res, 201, { authenticated: false, verificationSent: true });
    return;
  }

  if (path === '/api/v1/session' && req.method === 'POST') {
    exactOriginRequired(req, context.publicOrigin);
    if (!context.authLimiter.take(authRateKey(req, 'login'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.');
    }
    const body = objectBody(await readJson(req, API_BODY_LIMIT));
    // TOKCAD: sign in with the account name or its email address.
    const byEmail = typeof body.name === 'string' && body.name.includes('@')
      ? context.tokcad.accounts.byEmail(normalizeEmail(body.name) ?? '')
      : null;
    const signInName = byEmail ? byEmail.name : body.name;
    const account = await AUTH_WORK_LIMITER.run(
      () => store.authenticateAccount(signInName as string, body.password as string),
    );
    if (!account) throw new HttpError(401, 'INVALID_CREDENTIALS', 'The account name or passphrase is incorrect.');
    if (emailVerification() && !context.tokcad.accounts.isVerified(account.id)) {
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED',
        'Confirm your email first: open the link we sent you, or send a new one below.');
    }
    const prior = webSession(req, store);
    if (prior) store.revokeWebSession(prior.rawToken);
    const created = store.createWebSession(account.id);
    const session = store.getWebSession(created.token);
    if (!session) throw new Error('New account session was not persisted.');
    sendJson(req, res, 200, accountPayload(context, session), {
      'set-cookie': sessionCookie(req, created.token, created.expiresAt),
    });
    return;
  }

  if (path === '/api/v1/session' && req.method === 'DELETE') {
    exactOriginRequired(req, context.publicOrigin);
    requireJson(req);
    const authenticated = requireWebSession(req, store);
    requireCsrf(req, authenticated.session);
    store.revokeWebSession(authenticated.rawToken);
    relay.revokeAccount(authenticated.session.account.id);
    context.headless.revokeAccount(authenticated.session.account.id);
    sendJson(req, res, 200, { authenticated: false }, { 'set-cookie': clearSessionCookie(req) });
    return;
  }

  if (path === '/api/v1/account' && req.method === 'DELETE') {
    exactOriginRequired(req, context.publicOrigin);
    requireJson(req);
    const authenticated = requireWebSession(req, store);
    requireCsrf(req, authenticated.session);
    relay.revokeAccount(authenticated.session.account.id);
    context.headless.revokeAccount(authenticated.session.account.id);
    store.deleteAccount(authenticated.session.account.id);
    context.tokcad.accounts.deleteAccount(authenticated.session.account.id);   // TOKCAD
    sendJson(req, res, 200, { deleted: true, authenticated: false }, { 'set-cookie': clearSessionCookie(req) });
    return;
  }

  if (path === '/api/v1/agent-keys' && req.method === 'GET') {
    const authenticated = requireWebSession(req, store);
    sendJson(req, res, 200, {
      keys: store.listAgentKeys(authenticated.session.account.id).map(publicAgentKey),
    });
    return;
  }

  if (path === '/api/v1/agent-keys' && req.method === 'POST') {
    exactOriginRequired(req, context.publicOrigin);
    const authenticated = requireWebSession(req, store);
    requireCsrf(req, authenticated.session);
    const body = objectBody(await readJson(req, API_BODY_LIMIT));
    if (brandName && body.headless === true) {
      // TOKCAD: no server-headless CAD; agents work on projects open in the user's browser.
      throw new HttpError(400, 'HEADLESS_UNAVAILABLE', 'This server does not run agent projects without a browser.');
    }
    const created = store.createAgentKey(
      authenticated.session.account.id,
      body.label as string,
      body.access as 'read-only' | 'edit',
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      { headless: body.headless === true },
    );
    sendJson(req, res, 201, { rawKey: created.rawKey, key: publicAgentKey(created.key) });
    return;
  }

  const keyMatch = path.match(/^\/api\/v1\/agent-keys\/([A-Za-z0-9_-]{12})$/);
  if (keyMatch?.[1]) {
    requireMethod(req, ['DELETE']);
    exactOriginRequired(req, context.publicOrigin);
    requireJson(req);
    const authenticated = requireWebSession(req, store);
    requireCsrf(req, authenticated.session);
    const revoked = store.revokeAgentKey(authenticated.session.account.id, keyMatch[1]);
    if (!revoked) throw new HttpError(404, 'AGENT_KEY_NOT_FOUND', 'That agent key was not found.');
    relay.revokeKey(keyMatch[1]);
    context.headless.revokeKey(keyMatch[1]);
    sendJson(req, res, 200, { revoked: true, keyId: keyMatch[1] });
    return;
  }

  if (
    [
      '/api/v1/account',
      '/api/v1/accounts',
      '/api/v1/session',
      '/api/v1/agent-keys',
      '/api/v1/auth/google/link',
      '/api/v1/identities/google',
    ].includes(path)
  ) {
    const allowed = path === '/api/v1/accounts'
      ? 'POST'
      : path === '/api/v1/auth/google/link'
        ? 'POST'
        : path === '/api/v1/identities/google'
          ? 'DELETE'
      : path === '/api/v1/session'
        ? 'POST, DELETE'
        : path === '/api/v1/agent-keys'
          ? 'GET, POST'
          : 'GET, DELETE';
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', allowed);
  }

  throw new HttpError(404, 'API_NOT_FOUND', 'API route not found.');
}

async function handleGoogleStart(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  requireMethod(req, ['GET']);
  const googleAuth = context.googleAuth;
  if (!googleAuth) {
    temporaryRedirect(req, res, 303, '/account?auth=google-unavailable', {
      'set-cookie': clearGoogleBindingCookie(req),
    });
    return;
  }
  if (!context.authLimiter.take(authRateKey(req, 'google-start'), AUTH_ATTEMPT_LIMIT, AUTH_WINDOW_MS)) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many Google sign-in attempts. Try again later.');
  }
  try {
    const started = await googleAuth.begin(
      'sign-in',
      googleCallbackUri(req, context.publicOrigin),
    );
    temporaryRedirect(req, res, 302, started.authorizationUrl.href, {
      'set-cookie': googleBindingCookie(req, started.browserBinding, started.expiresAt),
    });
  } catch {
    temporaryRedirect(req, res, 303, '/account?auth=google-unavailable', {
      'set-cookie': clearGoogleBindingCookie(req),
    });
  }
}

async function handleGoogleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  requireMethod(req, ['GET']);
  const googleAuth = context.googleAuth;
  if (!googleAuth) {
    temporaryRedirect(req, res, 303, '/account?auth=google-unavailable', {
      'set-cookie': clearGoogleBindingCookie(req),
    });
    return;
  }
  let result = 'google-failed';
  try {
    const callbackUrl = absoluteRequestUrl(req, context.publicOrigin);
    const binding = parseCookies(req).get(googleBindingCookieName(req)) ?? '';
    const completed = await googleAuth.complete(callbackUrl, binding);
    let accountId: string;
    if (completed.intent === 'link') {
      const authenticated = webSession(req, context.store);
      if (!authenticated || authenticated.session.account.id !== completed.accountId) {
        result = 'google-session-ended';
        throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'The PartMode session used to start linking has ended.');
      }
      context.store.linkExternalIdentity(authenticated.session.account.id, completed.identity);
      context.store.revokeWebSession(authenticated.rawToken);
      accountId = authenticated.session.account.id;
      result = 'google-linked';
    } else {
      const resolved = context.store.authenticateOrCreateExternalAccount(completed.identity);
      const prior = webSession(req, context.store);
      if (prior) context.store.revokeWebSession(prior.rawToken);
      accountId = resolved.account.id;
      result = resolved.created ? 'google-created' : 'google-signed-in';
    }
    const created = context.store.createWebSession(accountId);
    const session = context.store.getWebSession(created.token);
    if (!session) throw new Error('Google account session was not persisted.');
    temporaryRedirect(req, res, 303, `/account?auth=${result}`, {
      'set-cookie': [
        sessionCookie(req, created.token, created.expiresAt),
        clearGoogleBindingCookie(req),
      ],
    });
    return;
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      if (error.code === 'GOOGLE_AUTH_CANCELLED') result = 'google-cancelled';
      else if (error.code === 'GOOGLE_AUTH_TRANSACTION_EXPIRED') result = 'google-expired';
    } else if (error instanceof AccountStoreError && error.code === 'EXTERNAL_IDENTITY_TAKEN') {
      result = 'google-already-used';
    } else if (!(error instanceof HttpError && error.code === 'AUTHENTICATION_REQUIRED')) {
      const name = error instanceof Error ? error.name : typeof error;
      console.error(`PartMode Google callback failed (${name})`);
    }
  }
  temporaryRedirect(req, res, 303, `/account?auth=${result}`, {
    'set-cookie': clearGoogleBindingCookie(req),
  });
}

async function handleStudioApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: ApiContext,
): Promise<void> {
  requireMethod(req, ['POST']);
  exactOriginRequired(req, context.publicOrigin);
  const authenticated = requireWebSession(req, context.store);
  requireCsrf(req, authenticated.session);
  const body = objectBody(await readJson(req, STUDIO_BODY_LIMIT));
  const accountId = authenticated.session.account.id;

  if (path === '/api/v1/studios/register') {
    const registration = context.relay.registerStudio(accountId, {
      label: body.label as string,
      protocol: body.protocol as string,
      tabId: body.tabId as string,
    });
    sendJson(req, res, 201, registration);
    return;
  }
  const studioId = typeof body.studioId === 'string' ? body.studioId : '';
  const studioToken = typeof body.studioToken === 'string' ? body.studioToken : '';
  if (path === '/api/v1/studios/poll') {
    sendJson(req, res, 200, await context.relay.pollStudio(accountId, studioId, studioToken));
    return;
  }
  if (path === '/api/v1/studios/respond') {
    context.relay.respondFromStudio(accountId, studioId, studioToken, {
      requestId: body.requestId as string,
      status: body.status as 'approved' | 'denied' | 'ok' | 'error',
      ...(body.result === undefined ? {} : { result: body.result }),
      ...(body.error && typeof body.error === 'object' ? { error: body.error as BrowserResponseError } : {}),
    });
    sendJson(req, res, 200, { accepted: true });
    return;
  }
  if (path === '/api/v1/studios/unregister') {
    context.relay.unregisterStudio(accountId, studioId, studioToken);
    sendJson(req, res, 200, { unregistered: true });
    return;
  }
  throw new HttpError(404, 'API_NOT_FOUND', 'Studio relay route not found.');
}

type BrowserResponseError = {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
};

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  requireMethod(req, ['POST']);
  optionalMcpOrigin(req, context.publicOrigin);
  const identity = agentIdentity(req, context.store);
  const body = await readJson(req, MCP_BODY_LIMIT);
  const rawProtocolVersion = req.headers['mcp-protocol-version'];
  const requestProtocolVersion = Array.isArray(rawProtocolVersion)
    ? rawProtocolVersion.join(',')
    : rawProtocolVersion;
  const result = await handleMcpRequest(
    body,
    identity,
    context.relay,
    context.release,
    context.help,
    requestProtocolVersion,
    context.headless,
  );
  const responseHeaders = { 'mcp-protocol-version': MCP_PROTOCOL_VERSION };
  if (result.status === 202 || result.body === undefined) {
    send(
      req,
      res,
      result.status,
      'application/json; charset=utf-8',
      '',
      'no-store',
      responseHeaders,
    );
    return;
  }
  sendJson(req, res, result.status, result.body, responseHeaders);
}

function errorResponse(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof AccountStoreError) {
    const status = [
      'ACCOUNT_NAME_TAKEN',
      'EXTERNAL_IDENTITY_TAKEN',
      'EXTERNAL_PROVIDER_LINKED',
      'LAST_AUTH_METHOD',
    ].includes(error.code)
      ? 409
      : error.code === 'ACCOUNT_NOT_FOUND'
        ? 404
        : 400;
    sendJson(req, res, status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof GoogleAuthError) {
    const status = error.code === 'GOOGLE_AUTH_BUSY' ? 503 : 400;
    sendJson(req, res, status, {
      error: error.code,
      message: error.code === 'GOOGLE_AUTH_BUSY'
        ? 'Google sign-in is busy. Try again shortly.'
        : 'Google could not complete sign-in.',
    }, status === 503 ? { 'retry-after': '1' } : {});
    return;
  }
  if (error instanceof RelayError) {
    sendJson(req, res, error.status, {
      error: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(req, res, error.status, { error: error.code, message: error.message }, {
      ...(error.allow ? { allow: error.allow } : {}),
      ...(error.status === 401 ? { 'www-authenticate': 'Bearer realm="PartMode"' } : {}),
      ...(error.status === 429 ? { 'retry-after': '900' } : {}),
      ...(error.status === 503 && error.code === 'AUTH_BUSY' ? { 'retry-after': '1' } : {}),
    });
    return;
  }
  const name = error instanceof Error ? error.name : typeof error;
  console.error(`PartMode request failed (${name})`);
  sendJson(req, res, 500, { error: 'INTERNAL_ERROR', message: 'PartMode could not complete the request.' });
}

function requestHandler(
  distDir: string,
  release: ReleaseManifest,
  indexHtml: Buffer,
  helpHtml: Buffer,
  aboutHtml: Buffer,
  privacyHtml: Buffer,
  cookiesHtml: Buffer,
  accountHtml: Buffer,
  context: ApiContext,
) {
  const assetPrefix = `/assets/${release.assetVersion}/`;
  const assetRoot = resolve(distDir, 'assets', release.assetVersion);
  // TOKCAD: a branded build names its own address
  const site = brandPublicUrl || 'https://partmode.com';
  const robots = `User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /api/\nDisallow: /mcp\nSitemap: ${site}/sitemap.xml\n`;
  const sitemap =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    ['/', '/help', '/about', '/privacy', '/cookies']
      .map((page) => `  <url><loc>${site}${page}</loc></url>\n`).join('') +
    '</urlset>\n';

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://partmode.local');
      const path = url.pathname;

      if (path === '/mcp') {
        await handleMcp(req, res, context);
        return;
      }
      if (path === '/auth/google/start') {
        await handleGoogleStart(req, res, context);
        return;
      }
      if (path === '/auth/google/callback') {
        await handleGoogleCallback(req, res, context);
        return;
      }
      if (path === '/api/v1/help') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', 'GET, HEAD');
        }
        sendJson(req, res, 200, context.help);
        return;
      }
      if (path.startsWith('/api/v1/studios/')) {
        await handleStudioApi(req, res, path, context);
        return;
      }
      if (path.startsWith('/api/v1/')) {
        await handleAccountApi(req, res, path, context);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', 'GET, HEAD');
      }
      if (path === '/') {
        send(req, res, 200, 'text/html; charset=utf-8', indexHtml, 'public, max-age=0, must-revalidate',
          studioCsp ? { 'content-security-policy': studioCsp } : {});   // TOKCAD
        return;
      }
      if (path === '/help/' || path === '/help.html') {
        redirect(req, res, '/help');
        return;
      }
      if (path === '/help') {
        send(req, res, 200, 'text/html; charset=utf-8', helpHtml, 'public, max-age=0, must-revalidate');
        return;
      }
      if (path === '/about/' || path === '/about.html') {
        redirect(req, res, '/about');
        return;
      }
      if (path === '/about') {
        send(req, res, 200, 'text/html; charset=utf-8', aboutHtml, 'public, max-age=0, must-revalidate');
        return;
      }
      if (path === '/account/' || path === '/account.html') {
        redirect(req, res, '/account');
        return;
      }
      if (path === '/account') {
        send(req, res, 200, 'text/html; charset=utf-8', accountHtml, 'no-store', {
          'content-security-policy': ACCOUNT_CSP,
          'x-frame-options': 'DENY',
        });
        return;
      }
      if (path === '/privacy/' || path === '/privacy.html') {
        redirect(req, res, '/privacy');
        return;
      }
      if (path === '/privacy') {
        send(req, res, 200, 'text/html; charset=utf-8', privacyHtml, 'public, max-age=0, must-revalidate');
        return;
      }
      if (path === '/cookies/' || path === '/cookies.html') {
        redirect(req, res, '/cookies');
        return;
      }
      if (path === '/cookies') {
        send(req, res, 200, 'text/html; charset=utf-8', cookiesHtml, 'public, max-age=0, must-revalidate');
        return;
      }
      if (path === '/healthz') {
        const body = `${JSON.stringify({
          ok: true,
          product: release.product,
          version: release.version,
          sha: release.releaseSha,
          assetVersion: release.assetVersion,
          controlPlane: { ready: true, persistence: 'sqlite', relay: 'live-only' },
          authentication: { googleConfigured: context.googleAuth !== null },
          help: {
            schema: context.help.schema,
            sourceSha256: context.help.sourceSha256,
            resources: context.help.resources.length,
          },
          uptimeSeconds: Math.floor(process.uptime()),
        })}\n`;
        send(req, res, 200, 'application/json; charset=utf-8', body, 'no-store');
        return;
      }
      if (path === '/robots.txt') {
        send(req, res, 200, 'text/plain; charset=utf-8', robots, 'public, max-age=3600');
        return;
      }
      if (path === '/sitemap.xml') {
        send(req, res, 200, 'application/xml; charset=utf-8', sitemap, 'public, max-age=3600');
        return;
      }
      if (path.startsWith(assetPrefix)) {
        const file = safeAssetPath(assetRoot, path.slice(assetPrefix.length));
        if (!file) {
          send(req, res, 404, 'text/plain; charset=utf-8', 'Not found\n', 'no-store');
          return;
        }
        serveAsset(req, res, file);
        return;
      }

      send(req, res, 404, 'text/plain; charset=utf-8', 'Not found\n', 'no-store');
    } catch (error) {
      errorResponse(req, res, error);
    }
  };
}

function loadOrCreatePepper(stateDir: string): Buffer {
  const pepperPath = resolve(stateDir, 'control-plane-pepper');
  try {
    return readFileSync(pepperPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  const pepper = randomBytes(32);
  try {
    writeFileSync(pepperPath, pepper, { flag: 'wx', mode: 0o600 });
    return pepper;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readFileSync(pepperPath);
  }
}

function googleAuthFromEnvironment(): GoogleAuthService | null {
  const clientId = process.env.PARTMODE_GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.PARTMODE_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('Google auth requires both PARTMODE_GOOGLE_CLIENT_ID and PARTMODE_GOOGLE_CLIENT_SECRET.');
  }
  return clientId && clientSecret ? new GoogleAuthService({ clientId, clientSecret }) : null;
}

export async function startPartModeServer(
  options: PartModeServerOptions = {},
): Promise<RunningPartModeServer> {
  const distDir = resolve(options.distDir ?? process.env.PARTMODE_DIST_DIR ?? 'dist');
  const release = JSON.parse(readFileSync(resolve(distDir, 'release.json'), 'utf8')) as ReleaseManifest;
  basePath = release.basePath ?? '';
  brandName = release.brand?.name ?? '';                       // TOKCAD
  brandPublicUrl = release.brand?.publicUrl ?? '';
  const indexHtml = readFileSync(resolve(distDir, 'index.html'));
  studioCsp = release.brand ? studioCspFor(indexHtml.toString('utf8')) : '';   // TOKCAD
  const helpHtml = readFileSync(resolve(distDir, 'help.html'));
  const aboutHtml = readFileSync(resolve(distDir, 'about.html'));
  const help = JSON.parse(readFileSync(resolve(distDir, 'help-resources.json'), 'utf8')) as PartModeHelpManifest;
  const privacyHtml = readFileSync(resolve(distDir, 'privacy.html'));
  const cookiesHtml = readFileSync(resolve(distDir, 'cookies.html'));
  const accountHtml = readFileSync(resolve(distDir, 'account.html'));
  const host = options.host ?? process.env.PARTMODE_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PARTMODE_PORT ?? 4401);
  const configuredStateDir = options.stateDir ?? process.env.PARTMODE_STATE_DIR;
  const publicOrigin = options.publicOrigin ?? process.env.PARTMODE_PUBLIC_ORIGIN;
  const googleAuth = options.googleAuth === undefined
    ? googleAuthFromEnvironment()
    : options.googleAuth;
  if (process.env.NODE_ENV === 'production' && !configuredStateDir) {
    throw new Error('PARTMODE_STATE_DIR is required in production; ephemeral account storage is prohibited.');
  }
  if (process.env.NODE_ENV === 'production' && !emailVerification()) {
    throw new Error('TOKCAD_EMAIL_VERIFICATION=off is for tests; it is refused in production.');
  }
  if (process.env.NODE_ENV === 'production' && !publicOrigin) {
    throw new Error('PARTMODE_PUBLIC_ORIGIN is required in production for exact-origin enforcement.');
  }
  const stateDir = resolve(configuredStateDir ?? '/tmp/partmode-development');
  if (publicOrigin && !/^https?:\/\/[^/]+$/.test(publicOrigin)) throw new Error('PARTMODE_PUBLIC_ORIGIN must be an exact origin.');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const store = AccountStore.open({
    filename: resolve(stateDir, 'partmode.sqlite'),
    pepper: loadOrCreatePepper(stateDir),
  });
  const tokcadAccounts = new TokcadAccounts(stateDir);   // TOKCAD: verified email
  const relay = new RelayHub();
  const headless = new HeadlessSessionManager({
    store,
    staticDir: resolve(distDir, 'assets', release.assetVersion),
  });
  const context: ApiContext = {
    store,
    relay,
    headless,
    release,
    help,
    googleAuth,
    authLimiter: new FixedWindowLimiter(),
    tokcad: { accounts: tokcadAccounts, mailer: new Mailer(stateDir), mold: new MoldService(stateDir) },
    ...(publicOrigin ? { publicOrigin } : {}),
  };
  const handler = requestHandler(
    distDir,
    release,
    indexHtml,
    helpHtml,
    aboutHtml,
    privacyHtml,
    cookiesHtml,
    accountHtml,
    context,
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  let headlessClosePromise: Promise<void> | null = null;
  const closeHeadless = (): Promise<void> => {
    if (!headlessClosePromise) headlessClosePromise = headless.close();
    return headlessClosePromise;
  };
  let closeResourcesPromise: Promise<void> | null = null;
  const closeResources = (): Promise<void> => {
    if (closeResourcesPromise) return closeResourcesPromise;
    closeResourcesPromise = (async () => {
      let headlessError: unknown;
      try {
        await closeHeadless();
      } catch (error) {
        headlessError = error;
      } finally {
        googleAuth?.close();
        relay.close();
        store.close();
        tokcadAccounts.close();
      }
      if (headlessError) throw headlessError;
    })();
    return closeResourcesPromise;
  };
  server.on('close', () => {
    // The event cannot await, but RunningPartModeServer.close and the main
    // signal path await this exact promise before reporting completion or
    // exiting the process.
    void closeResources().catch(() => undefined);
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  } catch (error) {
    await closeResources();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PartMode server did not bind a TCP port');
  return {
    server,
    url: `http://${host}:${address.port}`,
    release,
    close: async () => {
      // Invalidate headless authority before waiting for active HTTP requests
      // to drain. A kernel call can otherwise outlive the service manager's
      // stop window and return or persist data after shutdown began.
      const headlessClosing = closeHeadless();
      let drainError: unknown;
      try {
        if (server.listening) {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          });
        }
      } catch (error) {
        drainError = error;
      }
      let resourceError: unknown;
      try {
        await headlessClosing;
      } catch (error) {
        resourceError = error;
      }
      try {
        await closeResources();
      } catch (error) {
        resourceError ??= error;
      }
      if (drainError) throw drainError;
      if (resourceError) throw resourceError;
    },
  };
}

async function main(): Promise<void> {
  const running = await startPartModeServer();
  console.log(`PartMode ${running.release.releaseSha} listening on ${running.url}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

let entrypoint = '';
if (process.argv[1]) {
  try {
    entrypoint = pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch {
    entrypoint = pathToFileURL(resolve(process.argv[1])).href;
  }
}
if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`PartMode failed to start (${name})`);
    process.exit(1);
  });
}
