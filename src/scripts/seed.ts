/* oxlint-disable no-console -- CLI script: console output is the UI. */
/**
 * Demo data for local development: `npm run db:seed` (builds, then runs dist/scripts/seed.js).
 *
 * Seeds through the REAL domain services (registration, KYC review, admin
 * credit, transfer) instead of raw inserts, so every balance is backed by a
 * balanced journal and the reconciliation check passes. Refuses to run in
 * production because it wipes the database.
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../app.module.js';
import type { AuthUser } from '../common/types/request.js';
import { PrismaService } from '../infra/prisma/prisma.service.js';
import { AdminWalletsService } from '../modules/admin/admin-wallets.service.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { PasswordService } from '../modules/auth/password.service.js';
import { KycService } from '../modules/kyc/kyc.service.js';
import { ReconciliationService } from '../modules/ledger/reconciliation.service.js';
import { SystemWalletsService } from '../modules/ledger/system-wallets.service.js';
import { TransfersService } from '../modules/transactions/transfers.service.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV=production');
  process.exit(1);
}

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@irate.dev';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!';
const USER_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Password123!';

const CUSTOMERS = [
  {
    email: 'ada@irate.dev',
    name: 'Ada Okafor',
    account: '1000000001',
    balance: 4_800_000n,
    kyc: true,
  },
  {
    email: 'bola@irate.dev',
    name: 'Bola Adeyemi',
    account: '1000000002',
    balance: 1_450_000n,
    kyc: true,
  },
  { email: 'chidi@irate.dev', name: 'Chidi Eze', account: '1000000003', balance: 0n, kyc: false },
];

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const prisma = app.get(PrismaService);
  const auth = app.get(AuthService);
  const kyc = app.get(KycService);
  const credits = app.get(AdminWalletsService);
  const transfers = app.get(TransfersService);
  const system = { userId: null, requestId: 'seed' };

  // TRUNCATE skips row triggers, so the append-only ledger can be reset here.
  await prisma.$executeRawUnsafe(
    'TRUNCATE users, refresh_tokens, kyc_records, wallets, transactions, ledger_entries, idempotency_keys, audit_logs, deposits, webhook_events RESTART IDENTITY CASCADE',
  );
  await app.get(SystemWalletsService).ensure();

  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: await app.get(PasswordService).hash(ADMIN_PASSWORD),
      role: 'ADMIN',
    },
  });
  const adminActor = { userId: admin.id, requestId: 'seed' };
  const adminPrincipal = { id: admin.id, email: admin.email, role: 'ADMIN' } as AuthUser;

  for (const c of CUSTOMERS) {
    const { user } = await auth.register({ email: c.email, password: USER_PASSWORD }, system);
    // Stable, memorable account numbers for the demo (no ledger history yet, so safe to change).
    const wallet = await prisma.wallet.update({
      where: { userId_currency: { userId: user.id, currency: 'NGN' } },
      data: { accountNumber: c.account },
    });

    if (c.kyc) {
      const record = await kyc.submit(
        user.id,
        {
          fullName: c.name,
          dateOfBirth: '1994-05-17',
          address: '12 Admiralty Way, Lekki, Lagos',
          idType: 'NIN',
          idNumber: `${c.account}0`,
        },
        { userId: user.id, requestId: 'seed' },
      );
      await kyc.review(record.id, { action: 'APPROVE' }, adminActor);
    }
    if (c.balance > 0n) {
      await credits.credit(
        adminPrincipal,
        wallet.id,
        { amount: Number(c.balance), reason: 'Opening balance' },
        randomUUID(),
        adminActor,
      );
    }
    console.log(
      `  ${c.email.padEnd(18)} ${c.account}  NGN ${(Number(c.balance) / 100).toLocaleString()}`,
    );
  }

  // One sample transfer so statements and the dashboard have data.
  const ada = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@irate.dev' } });
  await transfers.transfer(
    { id: ada.id, email: ada.email, role: 'USER' } as AuthUser,
    { toAccountNumber: '1000000002', amount: 250_000, note: 'Lunch' },
    randomUUID(),
    { userId: ada.id, requestId: 'seed' },
  );

  const report = await app.get(ReconciliationService).run();
  console.log(`\nSeeded. Admin: ${ADMIN_EMAIL}. Ledger reconciliation healthy: ${report.healthy}`);
} finally {
  await app.close();
}
