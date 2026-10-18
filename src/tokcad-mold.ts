// TOKCAD: the molding check. TOK CAD's server forwards a signed-in user's part to a private
// molding-analysis service (CAD EVAL's /api/mold/*, on the same machine) and passes its results
// back. The analysis itself is not part of this source; this file only relays requests.
//
// Configuration lives outside the repository, in <STATE_DIR>/mold.json:
//   { "url": "http://127.0.0.1:5000", "secret": "..." }
// Without that file the molding check is off and its routes answer 503.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MOLD_STEP_LIMIT = 50 * 1024 * 1024;      // the service refuses larger files too
export const MOLD_ANALYSES_PER_HOUR = 20;               // per account
export const MOLD_UPLOADS_PER_HOUR = 20;                // per account
const UPLOAD_TIMEOUT_MS = 90_000;                       // STEP read and tessellation
const ANALYZE_TIMEOUT_MS = 150_000;                     // the service gives up at 120 s

const SESSION_ID = /^[0-9a-f]{32}$/;

export class MoldServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MoldServiceError';
    this.status = status;
  }
}

interface MoldConfig { url: string; secret: string }

function loadConfig(stateDir: string): MoldConfig | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(stateDir, 'mold.json'), 'utf8')) as Record<string, unknown>;
    const url = typeof raw.url === 'string' ? raw.url.replace(/\/+$/, '') : '';
    const secret = typeof raw.secret === 'string' ? raw.secret : '';
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url) || secret.length < 16) {
      console.error('TOK CAD: mold.json needs a loopback "url" and a "secret" of 16+ characters; the molding check is off.');
      return null;
    }
    return { url, secret };
  } catch {
    return null;
  }
}

export function isMoldSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export class MoldService {
  readonly #stateDir: string;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
  }

  /** Read on every call, so the secret can be set or changed without a restart. */
  get enabled(): boolean {
    return loadConfig(this.#stateDir) !== null;
  }

  async createSession(owner: string, step: Buffer): Promise<{ session: string }> {
    const result = await this.#call('POST', '/api/mold/sessions', owner, step, 'application/octet-stream', UPLOAD_TIMEOUT_MS);
    if (typeof result.session !== 'string' || !isMoldSessionId(result.session)) {
      throw new MoldServiceError(502, 'The molding check gave an unexpected answer.');
    }
    return { session: result.session };
  }

  async analyze(
    owner: string, session: string, pull: [number, number, number] | null, cosmetic: Record<string, unknown>[] = [],
  ): Promise<Record<string, unknown>> {
    if (!isMoldSessionId(session)) throw new MoldServiceError(404, 'Unknown or expired molding check.');
    // "v2": the service's split rules (opening direction, parting end, walls), which TOK CAD uses.
    // "cosmetic": the faces the user said customers see; the service checks them in detail.
    const body = Buffer.from(JSON.stringify({ rules: 'v2', ...(pull ? { pull } : {}), ...(cosmetic.length ? { cosmetic } : {}) }));
    return this.#call('POST', `/api/mold/sessions/${session}/analyze`, owner, body, 'application/json', ANALYZE_TIMEOUT_MS);
  }

  async #call(
    method: string, path: string, owner: string, body: Buffer, contentType: string, timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const config = loadConfig(this.#stateDir);
    if (!config) throw new MoldServiceError(503, 'The molding check is not available on this server.');
    let response: Response;
    try {
      response = await fetch(`${config.url}${path}`, {
        method,
        headers: { 'x-mold-secret': config.secret, 'x-mold-owner': owner, 'content-type': contentType },
        body: new Blob([new Uint8Array(body)]),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      console.error('TOK CAD: molding service request failed:', error instanceof Error ? error.message : error);
      throw new MoldServiceError(timedOut ? 504 : 503, timedOut
        ? 'The molding check took too long. Try a simpler part, or try again later.'
        : 'The molding check is not available right now. Try again later.');
    }
    let value: Record<string, unknown> = {};
    try {
      value = (await response.json()) as Record<string, unknown>;
    } catch {
      // fall through with an empty body
    }
    if (response.ok) return value;
    const message = typeof value.error === 'string' ? value.error : 'The molding check failed.';
    // 400/413 are about the part and can be shown; anything else is the service's own trouble
    // (403 would mean a wrong secret), which the user cannot fix.
    if (response.status === 400 || response.status === 413) throw new MoldServiceError(response.status, message);
    if (response.status === 503) throw new MoldServiceError(503, message);
    console.error(`TOK CAD: molding service answered ${response.status}: ${message}`);
    throw new MoldServiceError(502, 'The molding check is not available right now. Try again later.');
  }
}
