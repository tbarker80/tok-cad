import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ACCOUNT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const AGENT_KEY_PATTERN = /^pmak_v1_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 32;
const OPAQUE_TOKEN_BYTES = 32;
const DEFAULT_WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_WEB_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const DUMMY_PASSWORD_SALT = randomBytes(PASSWORD_SALT_BYTES);
const DUMMY_PASSWORD_DIGEST = randomBytes(PASSWORD_KEY_BYTES);

export type AgentKeyAccess = 'read-only' | 'edit';

export interface AgentGrantCeiling {
  readonly granted: readonly string[];
}

export const AGENT_KEY_GRANT_CEILINGS: Readonly<Record<AgentKeyAccess, AgentGrantCeiling>> =
  Object.freeze({
    'read-only': Object.freeze({
      granted: Object.freeze([
        'project.read',
        'artifact.render',
        'artifact.export-project',
        'artifact.export-step',
        'artifact.export-stl',
        'artifact.export-amf',
        'artifact.export-3mf',
        'artifact.export-drawing',
        'artifact.export-narration',
        'ui.read',
        'ui.select',
        'ui.navigate',
        'ui.present-demo',
        'ui.present-narration',
        'ui.wait-events',
      ]),
    }),
    edit: Object.freeze({
      granted: Object.freeze([
        'project.read',
        'project.edit',
        'artifact.render',
        'artifact.export-project',
        'artifact.export-step',
        'artifact.export-stl',
        'artifact.export-amf',
        'artifact.export-3mf',
        'artifact.export-drawing',
        'artifact.export-narration',
        'ui.read',
        'ui.select',
        'ui.navigate',
        'ui.command-draft',
        'ui.present-preview',
        'ui.present-demo',
        'ui.present-narration',
        'ui.wait-events',
      ]),
    }),
  });

export interface Account {
  id: string;
  name: string;
  displayName: string | null;
  hasPassphrase: boolean;
  createdAt: string;
}

export interface ExternalIdentityInput {
  provider: string;
  issuer: string;
  subject: string;
  displayName: string | null;
}

export interface ExternalIdentity {
  provider: string;
  issuer: string;
  createdAt: string;
  lastAuthenticatedAt: string;
}

export interface ExternalAccountResult {
  account: Account;
  created: boolean;
}

export interface WebSession {
  account: Account;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedWebSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export interface AgentKey {
  id: string;
  accountId: string;
  label: string;
  access: AgentKeyAccess;
  grantCeiling: AgentGrantCeiling;
  /** Explicit opt-in, chosen at creation: this key may run server-side CAD
   * sessions with no browser approval step. Never mutable afterward. */
  headless: boolean;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface HeadlessDocumentRecord {
  projectId: string;
  name: string;
  revision: number;
  documentJson: string;
  documentHash: string;
  updatedAt: string;
}

export interface CreatedAgentKey {
  rawKey: string;
  key: AgentKey;
}

export interface AuthenticatedAgentKey {
  account: Account;
  key: AgentKey;
}

export interface AccountStoreOptions {
  filename: string;
  pepper: string | Uint8Array;
  now?: () => Date;
  webSessionTtlMs?: number;
}

export type AccountStoreErrorCode =
  | 'ACCOUNT_NAME_INVALID'
  | 'ACCOUNT_NAME_TAKEN'
  | 'ACCOUNT_NOT_FOUND'
  | 'PASSWORD_INVALID'
  | 'EXTERNAL_IDENTITY_INVALID'
  | 'EXTERNAL_IDENTITY_TAKEN'
  | 'EXTERNAL_PROVIDER_LINKED'
  | 'LAST_AUTH_METHOD'
  | 'AGENT_KEY_LABEL_INVALID'
  | 'AGENT_KEY_ACCESS_INVALID'
  | 'EXPIRY_INVALID'
  | 'STORE_CLOSED';

export class AccountStoreError extends Error {
  readonly code: AccountStoreErrorCode;

  constructor(code: AccountStoreErrorCode, message: string) {
    super(message);
    this.name = 'AccountStoreError';
    this.code = code;
  }
}

type AccountPublicRow = {
  id: string;
  name: string;
  display_name: string | null;
  password_enabled: number;
  created_at: number;
};

type AccountRow = AccountPublicRow & {
  password_salt: Uint8Array;
  password_digest: Uint8Array;
};

type WebSessionRow = AccountPublicRow & {
  csrf_token: string;
  session_created_at: number;
  expires_at: number;
};

type AgentKeyRow = {
  id: string;
  account_id: string;
  label: string;
  access: AgentKeyAccess;
  grant_ceiling: string;
  secret_digest: Uint8Array;
  headless: number;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

type AuthenticatedAgentKeyRow = AgentKeyRow & {
  account_name: string;
  account_display_name: string | null;
  account_password_enabled: number;
  account_created_at: number;
};

type ExternalIdentityRow = {
  provider: string;
  issuer: string;
  created_at: number;
  last_authenticated_at: number;
};

type ExternalAccountRow = AccountPublicRow & {
  identity_account_id: string;
};

function derivePassword(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_KEY_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function optionalIso(timestamp: number | null): string | null {
  return timestamp === null ? null : iso(timestamp);
}

function accountFromRow(row: AccountPublicRow): Account {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    hasPassphrase: row.password_enabled === 1,
    createdAt: iso(row.created_at),
  };
}

function externalIdentityFromRow(row: ExternalIdentityRow): ExternalIdentity {
  return {
    provider: row.provider,
    issuer: row.issuer,
    createdAt: iso(row.created_at),
    lastAuthenticatedAt: iso(row.last_authenticated_at),
  };
}

function cloneGrantCeiling(access: AgentKeyAccess): AgentGrantCeiling {
  return { granted: [...AGENT_KEY_GRANT_CEILINGS[access].granted] };
}

function agentKeyFromRow(row: AgentKeyRow): AgentKey {
  let grantCeiling: AgentGrantCeiling;
  try {
    const parsed = JSON.parse(row.grant_ceiling) as Partial<AgentGrantCeiling>;
    if (!Array.isArray(parsed.granted) || parsed.granted.some((item) => typeof item !== 'string')) {
      throw new Error('invalid grant ceiling');
    }
    grantCeiling = { granted: [...parsed.granted] };
  } catch {
    throw new Error(`Agent key ${row.id} has an invalid persisted grant ceiling.`);
  }
  return {
    id: row.id,
    accountId: row.account_id,
    label: row.label,
    access: row.access,
    grantCeiling,
    headless: row.headless === 1,
    createdAt: iso(row.created_at),
    expiresAt: optionalIso(row.expires_at),
    lastUsedAt: optionalIso(row.last_used_at),
    revokedAt: optionalIso(row.revoked_at),
  };
}

function normalizeAccountName(value: unknown): { name: string; displayName: string | null } {
  if (typeof value !== 'string') {
    throw new AccountStoreError('ACCOUNT_NAME_INVALID', 'Account name must be a string.');
  }
  const original = value.trim();
  const name = original.toLowerCase();
  if (!ACCOUNT_NAME_PATTERN.test(name)) {
    throw new AccountStoreError(
      'ACCOUNT_NAME_INVALID',
      'Account name must be 3-40 characters and use lowercase letters, numbers, dot, underscore, or hyphen.',
    );
  }
  return { name, displayName: original === name ? null : original };
}

function validAuthenticationName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return ACCOUNT_NAME_PATTERN.test(normalized) ? normalized : null;
}

function normalizeExternalIdentity(value: ExternalIdentityInput): ExternalIdentityInput {
  const provider = typeof value?.provider === 'string' ? value.provider.trim().toLowerCase() : '';
  const issuer = typeof value?.issuer === 'string' ? value.issuer.trim() : '';
  const subject = typeof value?.subject === 'string' ? value.subject : '';
  if (
    !/^[a-z][a-z0-9-]{1,31}$/.test(provider) ||
    !/^https:\/\/[^\s]{1,247}$/.test(issuer) ||
    subject.length < 1 ||
    subject.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(subject)
  ) {
    throw new AccountStoreError('EXTERNAL_IDENTITY_INVALID', 'The external identity is invalid.');
  }
  let displayName: string | null = null;
  if (typeof value.displayName === 'string') {
    const normalized = value.displayName
      .replace(/[\u0000-\u001f\u007f]/gu, '')
      .trim()
      .replace(/\s+/gu, ' ');
    if (normalized) displayName = Array.from(normalized).slice(0, 80).join('');
  }
  return { provider, issuer, subject, displayName };
}

function assertPassword(password: unknown): asserts password is string {
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new AccountStoreError(
      'PASSWORD_INVALID',
      `Passphrase must contain ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`,
    );
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AccountStoreError('AGENT_KEY_LABEL_INVALID', 'Agent key label must be a string.');
  }
  const label = value.trim();
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new AccountStoreError(
      'AGENT_KEY_LABEL_INVALID',
      'Agent key label must contain 1-80 printable characters.',
    );
  }
  return label;
}

function assertAccess(value: unknown): asserts value is AgentKeyAccess {
  if (value !== 'read-only' && value !== 'edit') {
    throw new AccountStoreError(
      'AGENT_KEY_ACCESS_INVALID',
      'Agent key access must be read-only or edit.',
    );
  }
}

function expiryTimestamp(value: Date | string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    throw new AccountStoreError('EXPIRY_INVALID', 'Agent key expiry must be a future date.');
  }
  return timestamp;
}

function isUniqueConstraint(error: unknown): boolean {
  const sqliteError = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return (
    sqliteError.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    sqliteError.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    sqliteError.errcode === 1_555 ||
    sqliteError.errcode === 2_067 ||
    (
      sqliteError.code === 'ERR_SQLITE_ERROR' &&
      typeof sqliteError.message === 'string' &&
      /\b(?:PRIMARY KEY|UNIQUE) constraint failed\b/.test(sqliteError.message)
    )
  );
}

export class AccountStore {
  readonly #database: DatabaseSync;
  readonly #pepper: Buffer;
  readonly #now: () => Date;
  readonly #webSessionTtlMs: number;
  #closed = false;

  private constructor(options: AccountStoreOptions) {
    if (!options || typeof options.filename !== 'string' || !options.filename.trim()) {
      throw new TypeError('AccountStore filename must be a non-empty string.');
    }
    const pepper = typeof options.pepper === 'string'
      ? Buffer.from(options.pepper, 'utf8')
      : Buffer.from(options.pepper);
    if (pepper.byteLength < 32) {
      throw new TypeError('AccountStore pepper must contain at least 32 bytes.');
    }
    const webSessionTtlMs = options.webSessionTtlMs ?? DEFAULT_WEB_SESSION_TTL_MS;
    if (
      !Number.isSafeInteger(webSessionTtlMs) ||
      webSessionTtlMs < 60_000 ||
      webSessionTtlMs > MAX_WEB_SESSION_TTL_MS
    ) {
      throw new TypeError('webSessionTtlMs must be an integer from one minute through 90 days.');
    }
    this.#database = new DatabaseSync(options.filename);
    this.#pepper = pepper;
    this.#now = options.now ?? (() => new Date());
    this.#webSessionTtlMs = webSessionTtlMs;
    this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  }

  static open(options: AccountStoreOptions): AccountStore {
    const store = new AccountStore(options);
    store.migrate();
    return store;
  }

  static create(options: AccountStoreOptions): AccountStore {
    return AccountStore.open(options);
  }

  migrate(): void {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS account_store_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          display_name TEXT,
          password_scheme TEXT NOT NULL,
          password_salt BLOB NOT NULL,
          password_digest BLOB NOT NULL,
          password_enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          CHECK (length(name) BETWEEN 3 AND 40),
          CHECK (password_scheme = 'scrypt-v1'),
          CHECK (length(password_salt) = 16),
          CHECK (length(password_digest) = 32),
          CHECK (password_enabled IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS web_sessions (
          token_digest BLOB PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          csrf_token TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          CHECK (length(token_digest) = 32),
          CHECK (length(csrf_token) = 43),
          CHECK (expires_at > created_at)
        );

        CREATE INDEX IF NOT EXISTS web_sessions_account_idx
          ON web_sessions(account_id);
        CREATE INDEX IF NOT EXISTS web_sessions_expiry_idx
          ON web_sessions(expires_at);

        CREATE TABLE IF NOT EXISTS agent_keys (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          access TEXT NOT NULL,
          grant_ceiling TEXT NOT NULL,
          secret_digest BLOB NOT NULL,
          headless INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          last_used_at INTEGER,
          revoked_at INTEGER,
          CHECK (length(id) = 12),
          CHECK (length(label) BETWEEN 1 AND 80),
          CHECK (access IN ('read-only', 'edit')),
          CHECK (length(secret_digest) = 32),
          CHECK (headless IN (0, 1)),
          CHECK (expires_at IS NULL OR expires_at > created_at)
        );

        CREATE INDEX IF NOT EXISTS agent_keys_account_idx
          ON agent_keys(account_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS agent_keys_active_idx
          ON agent_keys(id, revoked_at, expires_at);

        CREATE TABLE IF NOT EXISTS external_identities (
          provider TEXT NOT NULL,
          issuer TEXT NOT NULL,
          subject TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          last_authenticated_at INTEGER NOT NULL,
          PRIMARY KEY (issuer, subject),
          UNIQUE (account_id, provider),
          CHECK (length(provider) BETWEEN 2 AND 32),
          CHECK (length(issuer) BETWEEN 9 AND 255),
          CHECK (length(subject) BETWEEN 1 AND 255),
          CHECK (last_authenticated_at >= created_at)
        );

        CREATE INDEX IF NOT EXISTS external_identities_account_idx
          ON external_identities(account_id, provider);

        CREATE TABLE IF NOT EXISTS headless_documents (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          revision INTEGER NOT NULL,
          document_json TEXT NOT NULL,
          document_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, project_id),
          CHECK (length(project_id) BETWEEN 1 AND 200),
          CHECK (length(name) BETWEEN 1 AND 200),
          CHECK (revision >= 0),
          CHECK (length(document_json) <= 8388608),
          CHECK (length(document_hash) = 64),
          CHECK (updated_at >= created_at)
        );
      `);
      const accountColumns = this.#database.prepare(
        'PRAGMA table_info(accounts)',
      ).all() as Array<{ name?: unknown }>;
      if (!accountColumns.some((column) => column.name === 'password_enabled')) {
        this.#database.exec(`
          ALTER TABLE accounts
          ADD COLUMN password_enabled INTEGER NOT NULL DEFAULT 1
          CHECK (password_enabled IN (0, 1));
        `);
      }
      const agentKeyColumns = this.#database.prepare(
        'PRAGMA table_info(agent_keys)',
      ).all() as Array<{ name?: unknown }>;
      if (!agentKeyColumns.some((column) => column.name === 'headless')) {
        this.#database.exec(`
          ALTER TABLE agent_keys
          ADD COLUMN headless INTEGER NOT NULL DEFAULT 0
          CHECK (headless IN (0, 1));
        `);
      }
      this.#database.prepare(
        'INSERT OR IGNORE INTO account_store_migrations(version, applied_at) VALUES (?, ?)',
      ).run(1, this.#timestamp());
      this.#database.prepare(
        'INSERT OR IGNORE INTO account_store_migrations(version, applied_at) VALUES (?, ?)',
      ).run(2, this.#timestamp());
      this.#database.exec('COMMIT;');
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pepper.fill(0);
    this.#database.close();
  }

  async createAccount(name: string, password: string): Promise<Account> {
    this.#assertOpen();
    const normalized = normalizeAccountName(name);
    assertPassword(password);
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const digest = await derivePassword(password, salt);
    const account: Account = {
      id: randomUUID(),
      name: normalized.name,
      displayName: normalized.displayName,
      hasPassphrase: true,
      createdAt: iso(this.#timestamp()),
    };
    try {
      this.#database.prepare(`
        INSERT INTO accounts(
          id, name, display_name, password_scheme, password_salt, password_digest,
          password_enabled, created_at
        ) VALUES (?, ?, ?, 'scrypt-v1', ?, ?, 1, ?)
      `).run(
        account.id,
        account.name,
        account.displayName,
        salt,
        digest,
        Date.parse(account.createdAt),
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AccountStoreError('ACCOUNT_NAME_TAKEN', 'That account name is already registered.');
      }
      throw error;
    } finally {
      digest.fill(0);
    }
    return account;
  }

  // TOKCAD: password reset by email. Re-enables the passphrase on the account.
  async setPassword(accountId: string, password: string): Promise<void> {
    this.#assertOpen();
    assertPassword(password);
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const digest = await derivePassword(password, salt);
    try {
      const result = this.#database.prepare(`
        UPDATE accounts SET password_salt = ?, password_digest = ?, password_enabled = 1 WHERE id = ?
      `).run(salt, digest, accountId);
      if (result.changes !== 1) throw new AccountStoreError('ACCOUNT_NOT_FOUND', 'Account not found.');
    } finally {
      digest.fill(0);
    }
  }

  async authenticateAccount(name: string, password: string): Promise<Account | null> {
    this.#assertOpen();
    const normalizedName = validAuthenticationName(name);
    if (
      typeof password !== 'string' ||
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH
    ) return null;
    const row = normalizedName
      ? this.#database.prepare(`
          SELECT id, name, display_name, password_salt, password_digest,
                 password_enabled, created_at
          FROM accounts WHERE name = ?
        `).get(normalizedName) as AccountRow | undefined
      : undefined;
    const candidate = await derivePassword(password, row?.password_salt ?? DUMMY_PASSWORD_SALT);
    const expected = Buffer.from(row?.password_digest ?? DUMMY_PASSWORD_DIGEST);
    const matches = candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
    candidate.fill(0);
    expected.fill(0);
    return row && row.password_enabled === 1 && matches ? accountFromRow(row) : null;
  }

  authenticateOrCreateExternalAccount(input: ExternalIdentityInput): ExternalAccountResult {
    this.#assertOpen();
    const identity = normalizeExternalIdentity(input);
    const now = this.#timestamp();
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.#database.prepare(`
        SELECT
          accounts.id,
          accounts.name,
          accounts.display_name,
          accounts.password_enabled,
          accounts.created_at
        FROM external_identities
        JOIN accounts ON accounts.id = external_identities.account_id
        WHERE external_identities.issuer = ? AND external_identities.subject = ?
      `).get(identity.issuer, identity.subject) as AccountPublicRow | undefined;
      if (existing) {
        this.#database.prepare(`
          UPDATE external_identities
          SET last_authenticated_at = ?
          WHERE issuer = ? AND subject = ?
        `).run(now, identity.issuer, identity.subject);
        this.#database.exec('COMMIT;');
        return { account: accountFromRow(existing), created: false };
      }

      const account: Account = {
        id: randomUUID(),
        name: '',
        displayName: identity.displayName,
        hasPassphrase: false,
        createdAt: iso(now),
      };
      let inserted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        account.name = `${identity.provider}-${randomBytes(8).toString('hex')}`;
        try {
          this.#database.prepare(`
            INSERT INTO accounts(
              id, name, display_name, password_scheme, password_salt, password_digest,
              password_enabled, created_at
            ) VALUES (?, ?, ?, 'scrypt-v1', ?, ?, 0, ?)
          `).run(
            account.id,
            account.name,
            account.displayName,
            randomBytes(PASSWORD_SALT_BYTES),
            randomBytes(PASSWORD_KEY_BYTES),
            now,
          );
          inserted = true;
          break;
        } catch (error) {
          if (!isUniqueConstraint(error)) throw error;
        }
      }
      if (!inserted) throw new Error('Could not allocate a unique external account name.');
      this.#database.prepare(`
        INSERT INTO external_identities(
          provider, issuer, subject, account_id, created_at, last_authenticated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(identity.provider, identity.issuer, identity.subject, account.id, now, now);
      this.#database.exec('COMMIT;');
      return { account, created: true };
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  linkExternalIdentity(accountId: string, input: ExternalIdentityInput): ExternalIdentity {
    this.#assertOpen();
    const identity = normalizeExternalIdentity(input);
    const now = this.#timestamp();
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      this.#assertAccountExists(accountId);
      const existingIdentity = this.#database.prepare(`
        SELECT account_id
        FROM external_identities
        WHERE issuer = ? AND subject = ?
      `).get(identity.issuer, identity.subject) as { account_id: string } | undefined;
      if (existingIdentity && existingIdentity.account_id !== accountId) {
        throw new AccountStoreError(
          'EXTERNAL_IDENTITY_TAKEN',
          'That Google identity is already connected to another PartMode account.',
        );
      }
      const providerIdentity = this.#database.prepare(`
        SELECT provider, issuer, created_at, last_authenticated_at
        FROM external_identities
        WHERE account_id = ? AND provider = ?
      `).get(accountId, identity.provider) as ExternalIdentityRow | undefined;
      if (providerIdentity && !existingIdentity) {
        throw new AccountStoreError(
          'EXTERNAL_PROVIDER_LINKED',
          'This PartMode account already has a Google identity.',
        );
      }
      if (existingIdentity && providerIdentity) {
        this.#database.prepare(`
          UPDATE external_identities
          SET last_authenticated_at = ?
          WHERE issuer = ? AND subject = ?
        `).run(now, identity.issuer, identity.subject);
        this.#database.exec('COMMIT;');
        return externalIdentityFromRow({ ...providerIdentity, last_authenticated_at: now });
      }
      this.#database.prepare(`
        INSERT INTO external_identities(
          provider, issuer, subject, account_id, created_at, last_authenticated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(identity.provider, identity.issuer, identity.subject, accountId, now, now);
      this.#database.exec('COMMIT;');
      return {
        provider: identity.provider,
        issuer: identity.issuer,
        createdAt: iso(now),
        lastAuthenticatedAt: iso(now),
      };
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  listExternalIdentities(accountId: string): ExternalIdentity[] {
    this.#assertOpen();
    return (this.#database.prepare(`
      SELECT provider, issuer, created_at, last_authenticated_at
      FROM external_identities
      WHERE account_id = ?
      ORDER BY created_at ASC, provider ASC
    `).all(accountId) as ExternalIdentityRow[]).map(externalIdentityFromRow);
  }

  unlinkExternalIdentity(accountId: string, provider: string): boolean {
    this.#assertOpen();
    const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(normalizedProvider)) return false;
    this.#database.exec('BEGIN IMMEDIATE;');
    try {
      const account = this.#database.prepare(`
        SELECT password_enabled
        FROM accounts
        WHERE id = ?
      `).get(accountId) as { password_enabled: number } | undefined;
      if (!account) throw new AccountStoreError('ACCOUNT_NOT_FOUND', 'Account does not exist.');
      const target = this.#database.prepare(`
        SELECT 1 AS present
        FROM external_identities
        WHERE account_id = ? AND provider = ?
      `).get(accountId, normalizedProvider);
      if (!target) {
        this.#database.exec('COMMIT;');
        return false;
      }
      const identityCount = Number((this.#database.prepare(`
        SELECT COUNT(*) AS count
        FROM external_identities
        WHERE account_id = ?
      `).get(accountId) as { count: number | bigint }).count);
      if (account.password_enabled !== 1 && identityCount <= 1) {
        throw new AccountStoreError(
          'LAST_AUTH_METHOD',
          'Google is the only sign-in method for this account and cannot be disconnected.',
        );
      }
      const removed = this.#database.prepare(`
        DELETE FROM external_identities
        WHERE account_id = ? AND provider = ?
      `).run(accountId, normalizedProvider).changes > 0;
      this.#database.exec('COMMIT;');
      return removed;
    } catch (error) {
      this.#database.exec('ROLLBACK;');
      throw error;
    }
  }

  createWebSession(accountId: string): CreatedWebSession {
    this.#assertOpen();
    this.#assertAccountExists(accountId);
    const createdAt = this.#timestamp();
    const expiresAt = createdAt + this.#webSessionTtlMs;
    const token = randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
    const csrfToken = randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
    this.#database.prepare(`
      INSERT INTO web_sessions(token_digest, account_id, csrf_token, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.#digest(token), accountId, csrfToken, createdAt, expiresAt);
    return { token, csrfToken, expiresAt: iso(expiresAt) };
  }

  getWebSession(token: string): WebSession | null {
    this.#assertOpen();
    if (typeof token !== 'string' || token.length !== 43) return null;
    const digest = this.#digest(token);
    const row = this.#database.prepare(`
      SELECT
        accounts.id,
        accounts.name,
        accounts.display_name,
        accounts.password_enabled,
        accounts.created_at,
        web_sessions.csrf_token,
        web_sessions.created_at AS session_created_at,
        web_sessions.expires_at
      FROM web_sessions
      JOIN accounts ON accounts.id = web_sessions.account_id
      WHERE web_sessions.token_digest = ?
    `).get(digest) as WebSessionRow | undefined;
    if (!row) return null;
    if (row.expires_at <= this.#timestamp()) {
      this.#database.prepare('DELETE FROM web_sessions WHERE token_digest = ?').run(digest);
      return null;
    }
    return {
      account: accountFromRow(row),
      csrfToken: row.csrf_token,
      createdAt: iso(row.session_created_at),
      expiresAt: iso(row.expires_at),
    };
  }

  revokeWebSession(token: string): boolean {
    this.#assertOpen();
    if (typeof token !== 'string' || token.length !== 43) return false;
    return this.#database.prepare(
      'DELETE FROM web_sessions WHERE token_digest = ?',
    ).run(this.#digest(token)).changes > 0;
  }

  revokeAllWebSessions(accountId: string): number {
    this.#assertOpen();
    return Number(this.#database.prepare(
      'DELETE FROM web_sessions WHERE account_id = ?',
    ).run(accountId).changes);
  }

  createAgentKey(
    accountId: string,
    label: string,
    access: AgentKeyAccess,
    expiresAt?: Date | string,
    options: { headless?: boolean } = {},
  ): CreatedAgentKey {
    this.#assertOpen();
    this.#assertAccountExists(accountId);
    const normalizedLabel = normalizeLabel(label);
    assertAccess(access);
    const headless = options.headless === true;
    if (headless && access !== 'edit') {
      throw new AccountStoreError('AGENT_KEY_ACCESS_INVALID', 'Headless execution requires an edit-access key.');
    }
    const createdAt = this.#timestamp();
    const expiry = expiryTimestamp(expiresAt, createdAt);
    const grantCeiling = cloneGrantCeiling(access);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = randomBytes(9).toString('base64url');
      const secret = randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
      const rawKey = `pmak_v1_${id}_${secret}`;
      try {
        this.#database.prepare(`
          INSERT INTO agent_keys(
            id, account_id, label, access, grant_ceiling, secret_digest,
            headless, created_at, expires_at, last_used_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(
          id,
          accountId,
          normalizedLabel,
          access,
          JSON.stringify(grantCeiling),
          this.#digest(rawKey),
          headless ? 1 : 0,
          createdAt,
          expiry,
        );
        return {
          rawKey,
          key: {
            id,
            accountId,
            label: normalizedLabel,
            access,
            grantCeiling,
            headless,
            createdAt: iso(createdAt),
            expiresAt: optionalIso(expiry),
            lastUsedAt: null,
            revokedAt: null,
          },
        };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
      }
    }
    throw new Error('Could not allocate a unique agent key identifier.');
  }

  listAgentKeys(accountId: string): AgentKey[] {
    this.#assertOpen();
    return (this.#database.prepare(`
      SELECT
        id, account_id, label, access, grant_ceiling, secret_digest,
        headless, created_at, expires_at, last_used_at, revoked_at
      FROM agent_keys
      WHERE account_id = ?
      ORDER BY created_at DESC, id ASC
    `).all(accountId) as AgentKeyRow[]).map(agentKeyFromRow);
  }

  revokeAgentKey(accountId: string, keyId: string): boolean {
    this.#assertOpen();
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(keyId)) return false;
    return this.#database.prepare(`
      UPDATE agent_keys
      SET revoked_at = ?
      WHERE account_id = ? AND id = ? AND revoked_at IS NULL
    `).run(this.#timestamp(), accountId, keyId).changes > 0;
  }

  authenticateAgentKey(rawKey: string): AuthenticatedAgentKey | null {
    this.#assertOpen();
    const match = typeof rawKey === 'string' ? AGENT_KEY_PATTERN.exec(rawKey) : null;
    const id = match?.[1] ?? '';
    const candidateDigest = this.#digest(typeof rawKey === 'string' ? rawKey : '');
    const row = id
      ? this.#database.prepare(`
          SELECT
            agent_keys.id,
            agent_keys.account_id,
            agent_keys.label,
            agent_keys.access,
            agent_keys.grant_ceiling,
            agent_keys.secret_digest,
            agent_keys.headless,
            agent_keys.created_at,
            agent_keys.expires_at,
            agent_keys.last_used_at,
            agent_keys.revoked_at,
            accounts.name AS account_name,
            accounts.display_name AS account_display_name,
            accounts.password_enabled AS account_password_enabled,
            accounts.created_at AS account_created_at
          FROM agent_keys
          JOIN accounts ON accounts.id = agent_keys.account_id
          WHERE agent_keys.id = ?
        `).get(id) as AuthenticatedAgentKeyRow | undefined
      : undefined;
    const expectedDigest = Buffer.from(row?.secret_digest ?? Buffer.alloc(32));
    const authentic = timingSafeEqual(candidateDigest, expectedDigest);
    expectedDigest.fill(0);
    const now = this.#timestamp();
    if (
      !row ||
      !authentic ||
      row.revoked_at !== null ||
      (row.expires_at !== null && row.expires_at <= now)
    ) return null;
    this.#database.prepare(
      'UPDATE agent_keys SET last_used_at = ? WHERE id = ?',
    ).run(now, row.id);
    return {
      account: {
        id: row.account_id,
        name: row.account_name,
        displayName: row.account_display_name,
        hasPassphrase: row.account_password_enabled === 1,
        createdAt: iso(row.account_created_at),
      },
      key: agentKeyFromRow({ ...row, last_used_at: now }),
    };
  }

  putHeadlessDocument(
    accountId: string,
    record: { projectId: string; name: string; revision: number; documentJson: string; documentHash: string },
  ): void {
    this.#assertOpen();
    this.#assertAccountExists(accountId);
    const now = this.#timestamp();
    this.#database.prepare(`
      INSERT INTO headless_documents(
        account_id, project_id, name, revision, document_json, document_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, project_id) DO UPDATE SET
        name = excluded.name,
        revision = excluded.revision,
        document_json = excluded.document_json,
        document_hash = excluded.document_hash,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      record.projectId,
      record.name,
      record.revision,
      record.documentJson,
      record.documentHash,
      now,
      now,
    );
  }

  getHeadlessDocument(accountId: string, projectId: string): HeadlessDocumentRecord | null {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT project_id, name, revision, document_json, document_hash, updated_at
      FROM headless_documents
      WHERE account_id = ? AND project_id = ?
    `).get(accountId, projectId) as
      | { project_id: string; name: string; revision: number; document_json: string; document_hash: string; updated_at: number }
      | undefined;
    if (!row) return null;
    return {
      projectId: row.project_id,
      name: row.name,
      revision: row.revision,
      documentJson: row.document_json,
      documentHash: row.document_hash,
      updatedAt: iso(row.updated_at),
    };
  }

  listHeadlessDocuments(accountId: string): Array<Omit<HeadlessDocumentRecord, 'documentJson'>> {
    this.#assertOpen();
    return (this.#database.prepare(`
      SELECT project_id, name, revision, document_hash, updated_at
      FROM headless_documents
      WHERE account_id = ?
      ORDER BY updated_at DESC, project_id ASC
    `).all(accountId) as Array<{ project_id: string; name: string; revision: number; document_hash: string; updated_at: number }>)
      .map((row) => ({
        projectId: row.project_id,
        name: row.name,
        revision: row.revision,
        documentHash: row.document_hash,
        updatedAt: iso(row.updated_at),
      }));
  }

  deleteAccount(accountId: string): boolean {
    this.#assertOpen();
    return this.#database.prepare('DELETE FROM accounts WHERE id = ?').run(accountId).changes > 0;
  }

  #digest(value: string): Buffer {
    return createHmac('sha256', this.#pepper).update(value, 'utf8').digest();
  }

  #timestamp(): number {
    const value = this.#now().getTime();
    if (!Number.isSafeInteger(value)) throw new TypeError('AccountStore clock returned an invalid date.');
    return value;
  }

  #assertAccountExists(accountId: string): void {
    if (
      typeof accountId !== 'string' ||
      !this.#database.prepare('SELECT 1 AS present FROM accounts WHERE id = ?').get(accountId)
    ) {
      throw new AccountStoreError('ACCOUNT_NOT_FOUND', 'Account does not exist.');
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new AccountStoreError('STORE_CLOSED', 'Account store is closed.');
  }
}
