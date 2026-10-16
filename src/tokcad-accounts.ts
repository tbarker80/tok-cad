// TOKCAD: verified email for accounts, password reset, and the mail that carries both.
//
// Kept out of account-store.ts so upstream merges stay small: its own SQLite file next to the
// account store (tokcad.sqlite in the state directory), keyed by the account id upstream assigns.
// The server deletes these rows when it deletes an account (no cross-file foreign key).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';

export type TokenPurpose = 'verify' | 'reset';

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
const TOKEN_BYTES = 32;

export interface AccountEmail {
  accountId: string;
  name: string;
  email: string;
  verified: boolean;
}

/** Lower-cased address, or null when it is not a plausible single address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  // One @, no spaces or angle brackets, a dot in the domain: deliverability is proven by the link.
  if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(email)) return null;
  return email;
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

type EmailRow = { account_id: string; name: string; email: string; verified_at: number | null };

export class TokcadAccounts {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(stateDir: string, now: () => number = () => Date.now()) {
    this.#db = new DatabaseSync(resolve(stateDir, 'tokcad.sqlite'));
    this.#now = now;
    this.#db.exec(`
      PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS account_emails (
        account_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        verified_at INTEGER,
        created_at INTEGER NOT NULL,
        CHECK (length(email) BETWEEN 3 AND 254)
      );
      CREATE TABLE IF NOT EXISTS email_tokens (
        token_digest BLOB PRIMARY KEY,
        account_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        CHECK (purpose IN ('verify', 'reset')),
        CHECK (length(token_digest) = 32)
      );
      CREATE INDEX IF NOT EXISTS email_tokens_account_idx ON email_tokens(account_id, purpose);
    `);
  }

  close(): void {
    this.#db.close();
  }

  #row(where: 'account_id' | 'email', value: string): AccountEmail | null {
    const row = this.#db.prepare(
      `SELECT account_id, name, email, verified_at FROM account_emails WHERE ${where} = ?`,
    ).get(value) as EmailRow | undefined;
    return row
      ? { accountId: row.account_id, name: row.name, email: row.email, verified: row.verified_at !== null }
      : null;
  }

  byEmail(email: string): AccountEmail | null {
    return this.#row('email', email);
  }

  byAccount(accountId: string): AccountEmail | null {
    return this.#row('account_id', accountId);
  }

  /** Accounts with no email row are treated as unverified: every TOK CAD account has one. */
  isVerified(accountId: string): boolean {
    return this.byAccount(accountId)?.verified === true;
  }

  addEmail(accountId: string, name: string, email: string): void {
    this.#db.prepare(
      'INSERT INTO account_emails(account_id, name, email, verified_at, created_at) VALUES (?, ?, ?, NULL, ?)',
    ).run(accountId, name, email, this.#now());
  }

  markVerified(accountId: string): void {
    this.#db.prepare(
      'UPDATE account_emails SET verified_at = COALESCE(verified_at, ?) WHERE account_id = ?',
    ).run(this.#now(), accountId);
  }

  /** A new single-use token; earlier unused tokens of the same purpose stop working. */
  createToken(accountId: string, purpose: TokenPurpose): string {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.#now();
    this.#db.prepare(
      'UPDATE email_tokens SET used_at = ? WHERE account_id = ? AND purpose = ? AND used_at IS NULL',
    ).run(now, accountId, purpose);
    this.#db.prepare(
      'INSERT INTO email_tokens(token_digest, account_id, purpose, expires_at) VALUES (?, ?, ?, ?)',
    ).run(digest(token), accountId, purpose, now + (purpose === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS));
    return token;
  }

  /** The token's account if it is unused, unexpired and for this purpose; it is then spent. */
  consumeToken(token: unknown, purpose: TokenPurpose): string | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = digest(token);
    const row = this.#db.prepare(
      'SELECT token_digest, account_id, purpose, expires_at, used_at FROM email_tokens WHERE token_digest = ?',
    ).get(key) as { token_digest: Uint8Array; account_id: string; purpose: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || !timingSafeEqual(Buffer.from(row.token_digest), key)) return null;
    if (row.purpose !== purpose || row.used_at !== null || row.expires_at <= this.#now()) return null;
    const spent = this.#db.prepare(
      'UPDATE email_tokens SET used_at = ? WHERE token_digest = ? AND used_at IS NULL',
    ).run(this.#now(), key);
    return spent.changes === 1 ? row.account_id : null;
  }

  deleteAccount(accountId: string): void {
    this.#db.prepare('DELETE FROM email_tokens WHERE account_id = ?').run(accountId);
    this.#db.prepare('DELETE FROM account_emails WHERE account_id = ?').run(accountId);
  }
}

// ── mail ─────────────────────────────────────────────────────────────────────────────────────

interface MailConfig {
  from: string;
  smtp?: { host: string; port: number; secure?: boolean; user: string; pass: string };
  outbox?: string;          // development: write each message as JSON here instead of sending
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends through the SMTP account in <stateDir>/mail.json (never in the repository), or writes
 * to an outbox folder in development. Without a config, sending throws and the caller says the
 * email could not be sent. */
export class Mailer {
  readonly #config: MailConfig | null;
  readonly #transport: nodemailer.Transporter | null;

  constructor(stateDir: string) {
    const path = resolve(stateDir, 'mail.json');
    this.#config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as MailConfig : null;
    const smtp = this.#config?.smtp;
    this.#transport = smtp
      ? nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure ?? smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.pass },
        })
      : null;
  }

  get configured(): boolean {
    return Boolean(this.#config && (this.#transport || this.#config.outbox));
  }

  async send(message: MailMessage): Promise<void> {
    const config = this.#config;
    if (!config) throw new Error('Mail is not configured (mail.json missing).');
    if (config.outbox) {
      mkdirSync(config.outbox, { recursive: true });
      const name = `${Date.now()}-${randomBytes(4).toString('hex')}.json`;
      writeFileSync(resolve(config.outbox, name), JSON.stringify({ from: config.from, ...message }, null, 2));
      return;
    }
    if (!this.#transport) throw new Error('Mail is not configured (no smtp in mail.json).');
    await this.#transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text });
  }
}

// ── messages ─────────────────────────────────────────────────────────────────────────────────

const SIGNATURE = '\n-- \nTOK CAD, https://tok-share.com/cad\nIf you did not ask for this, ignore this email.\n';

export function verifyMessage(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: 'Confirm your TOK CAD email',
    text: `Hello ${name},\n\nConfirm this email address to finish creating your TOK CAD account:\n\n${link}\n\n` +
      `The link works once and expires in 24 hours.\n${SIGNATURE}`,
  };
}

export function resetMessage(to: string, name: string, link: string): MailMessage {
  return {
    to,
    subject: 'Reset your TOK CAD password',
    text: `Hello ${name},\n\nSomeone asked to reset the password of the TOK CAD account "${name}". ` +
      `To choose a new password, open:\n\n${link}\n\nThe link works once and expires in 1 hour. ` +
      `Your password stays the same until you use it.\n${SIGNATURE}`,
  };
}

export function alreadyRegisteredMessage(to: string, name: string, signInLink: string): MailMessage {
  return {
    to,
    subject: 'Your TOK CAD account',
    text: `Hello,\n\nSomeone tried to create a TOK CAD account with this email address, which already ` +
      `belongs to the account "${name}". To sign in, or reset its password, go to:\n\n${signInLink}\n${SIGNATURE}`,
  };
}
