import { Injectable, OnModuleInit } from '@nestjs/common';
import { argon2id, hash, needsRehash, verify } from 'argon2';
import { randomToken } from '../../common/utils/crypto.js';

/** OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane). */
const ARGON2_OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /** Verified against when the email is unknown, so response time doesn't reveal which emails exist. */
  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomToken());
  }

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string | null | undefined, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash || this.dummyHash, password);
    } catch {
      return false;
    }
  }

  /** True when the hash was made with older parameters and should be upgraded on login. */
  needsRehash(passwordHash: string): boolean {
    return needsRehash(passwordHash, ARGON2_OPTIONS);
  }
}
