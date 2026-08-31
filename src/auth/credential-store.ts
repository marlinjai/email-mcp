import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

/**
 * Ordered list of seed candidates used to derive the encryption key.
 *
 * The first entry is the preferred (most stable) seed used for new writes; the
 * remaining entries let credential files written by an older version — or
 * before a hostname change — still be decrypted, after which they are
 * transparently re-encrypted with the preferred seed.
 */
function getSeedCandidates(): string[] {
  const seeds: string[] = [];
  const username = os.userInfo().username;

  // 1. Explicit user-provided key always wins and is fully portable.
  const envKey = process.env.EMAIL_MCP_KEY;
  if (envKey) seeds.push(`email-mcp:env:${envKey}`);

  // 2. Stable hardware/machine identifier (survives mDNS hostname drift).
  const machineId = getStableMachineId();
  if (machineId) seeds.push(`email-mcp:machine:${machineId}:${username}`);

  // 3. Legacy hostname-based seed for backward compatibility / migration.
  seeds.push(`email-mcp:${os.hostname()}:${username}`);

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
 * (and migrate away from) legacy seeds.
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

interface StoredData {
  accounts: Record<string, AccountCredentials>;
}

export class CredentialStore {
  private filePath: string;

  constructor(dir?: string) {
    const baseDir = dir ?? path.join(os.homedir(), '.email-mcp');
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    }
    this.filePath = path.join(baseDir, 'credentials.enc');
  }

  private read(): StoredData {
    if (!fs.existsSync(this.filePath)) {
      return { accounts: {} };
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const seeds = getSeedCandidates();
    const { plaintext, seedUsed } = decrypt(raw, seeds);
    const data = JSON.parse(plaintext) as StoredData;

    // Transparently re-encrypt with the preferred seed when an older/legacy
    // seed was used, so future reads survive hostname changes (issue #4).
    if (seedUsed !== seeds[0]) {
      try {
        this.write(data);
      } catch {
        // Migration is best-effort; the read itself already succeeded.
      }
    }
    return data;
  }

  private write(data: StoredData): void {
    const json = JSON.stringify(data);
    const encrypted = encrypt(json, getSeedCandidates()[0]);
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
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

  async remove(id: string): Promise<void> {
    const data = this.read();
    delete data.accounts[id];
    this.write(data);
  }
}
