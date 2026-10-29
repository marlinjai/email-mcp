import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDataDir } from '../config.js';
import type { AccountCredentials } from '../models/types.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

let cachedMachineId: string | null | undefined;

/**
 * Returns a hardware/OS identifier that is stable across reboots and network
 * changes. Unlike os.hostname(), these values do not change when macOS
 * renumbers its mDNS/Bonjour name on a naming conflict (see issue #4), which
 * would otherwise make credentials.enc permanently undecryptable.
 *
 * Returns null when no stable identifier can be obtained, in which case the
 * caller falls back to the legacy hostname-based seed.
 */
function getStableMachineId(): string | null {
  if (cachedMachineId !== undefined) return cachedMachineId;
  cachedMachineId = computeStableMachineId();
  return cachedMachineId;
}

function computeStableMachineId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf-8',
      });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match ? match[1] : null;
    }
    if (process.platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(p)) {
          const id = fs.readFileSync(p, 'utf-8').trim();
          if (id) return id;
        }
      }
      return null;
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf-8' },
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/);
      return match ? match[1] : null;
    }
  } catch {
    // ioreg/reg unavailable or failed — fall back to the hostname-based seed.
  }
  return null;
}

/** Require a separately generated secret; machine identifiers are public metadata. */
export function requireEncryptionKey(): string {
  const key = process.env.EMAIL_MCP_KEY;
  if (!key || key.length < 32) {
    throw new Error('Set EMAIL_MCP_KEY to an independently generated secret of at least 32 characters before setup or startup.');
  }
  return key;
}

/** Return the required secret seed first, adding machine-derived seeds only for explicit legacy migration. */
function getSeedCandidates(): string[] {
  const seeds = [`email-mcp:env:${requireEncryptionKey()}`];
  // Only an operator can opt into importing credentials encrypted by old versions.
  if (process.env.EMAIL_MCP_MIGRATE_LEGACY === 'true') {
    const username = os.userInfo().username;
    const machineId = getStableMachineId();
    if (machineId) seeds.push(`email-mcp:machine:${machineId}:${username}`);
    seeds.push(`email-mcp:${os.hostname()}:${username}`);
  }
  return seeds;
}

function deriveKey(seed: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(seed, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function encrypt(plaintext: string, seed: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(seed, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted,
  });
}

/**
 * Attempts to decrypt the ciphertext against each seed candidate in order,
 * returning the plaintext and the seed that succeeded so the caller can detect
 * (and explicitly migrate away from) legacy seeds.
 */
function decrypt(ciphertext: string, seeds: string[]): { plaintext: string; seedUsed: string } {
  const { salt, iv, authTag, data } = JSON.parse(ciphertext);
  const saltBuf = Buffer.from(salt, 'hex');
  const ivBuf = Buffer.from(iv, 'hex');
  const authTagBuf = Buffer.from(authTag, 'hex');
  let lastError: unknown;

  for (const seed of seeds) {
    try {
      const key = deriveKey(seed, saltBuf);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
      decipher.setAuthTag(authTagBuf);

      let decrypted = decipher.update(data, 'hex', 'utf-8');
      decrypted += decipher.final('utf-8');
      return { plaintext: decrypted, seedUsed: seed };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('Unable to decrypt credentials');
}

/** Shared encryption for credentials and MSAL cache. Name retained for compatibility. */
export function encryptWithMachineKey(plaintext: string): string {
  return encrypt(plaintext, `email-mcp:env:${requireEncryptionKey()}`);
}

/**
 * Decrypts a payload written by encryptWithMachineKey (or by any older version
 * of credentials.enc). `usedLegacyKey` is true when a fallback seed matched, so
 * the caller can re-encrypt with the preferred key. Throws on a wrong key or on
 * any modification of the payload (GCM authentication), and on a payload that
 * is not the expected JSON envelope.
 */
export function decryptWithMachineKey(ciphertext: string): {
  plaintext: string;
  usedLegacyKey: boolean;
} {
  const seeds = getSeedCandidates();
  const { plaintext, seedUsed } = decrypt(ciphertext, seeds);
  return { plaintext, usedLegacyKey: seedUsed !== seeds[0] };
}

/** Atomic replacement avoids truncation and does not follow a destination symlink. */
export function writePrivateFile(filePath: string, content: string | Uint8Array): void {
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

interface StoredData {
  accounts: Record<string, AccountCredentials>;
}

export class CredentialStore {
  private filePath: string;

  /** Select the credential directory and create it with owner-only permissions when absent. */
  constructor(dir?: string) {
    const baseDir = dir ?? getDataDir();
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
    this.filePath = path.join(baseDir, 'credentials.enc');
  }

  /** Decrypt stored accounts and migrate an accepted legacy key; return an empty store only when no file exists. */
  private read(): StoredData {
    if (!fs.existsSync(this.filePath)) {
      return { accounts: {} };
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const { plaintext, usedLegacyKey } = decryptWithMachineKey(raw);
    const data = JSON.parse(plaintext) as StoredData;

    if (usedLegacyKey) this.write(data);
    return data;
  }

  /** Encrypt the complete account store with the independent secret and replace the file atomically. */
  private write(data: StoredData): void {
    const json = JSON.stringify(data);
    const encrypted = encryptWithMachineKey(json);
    writePrivateFile(this.filePath, encrypted);
  }

  async save(creds: AccountCredentials): Promise<void> {
    const data = this.read();
    data.accounts[creds.id] = creds;
    this.write(data);
  }

  async get(id: string): Promise<AccountCredentials | null> {
    const data = this.read();
    return data.accounts[id] ?? null;
  }

  async list(): Promise<AccountCredentials[]> {
    const data = this.read();
    return Object.values(data.accounts);
  }

  /**
   * The account already configured for this mailbox, if any. Provider plus
   * address identifies a mailbox; the address comparison is case-insensitive
   * because providers report it in varying case.
   */
  async findByProviderAndEmail(
    provider: AccountCredentials['provider'],
    email: string,
  ): Promise<AccountCredentials | null> {
    const wanted = email.trim().toLowerCase();
    const data = this.read();
    return (
      Object.values(data.accounts).find(
        (a) => a.provider === provider && a.email.trim().toLowerCase() === wanted,
      ) ?? null
    );
  }

  async remove(id: string): Promise<void> {
    const data = this.read();
    delete data.accounts[id];
    this.write(data);
  }
}
