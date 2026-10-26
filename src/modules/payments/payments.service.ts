import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { pageMeta, PaginationQueryDto, skipTake } from '../../common/dto/pagination.dto.js';
import type { Actor, AuthUser } from '../../common/types/request.js';
import { randomBase32 } from '../../common/utils/crypto.js';
import { generateReference } from '../../common/utils/reference.js';
import type { Env } from '../../config/env.js';
import type { Deposit } from '../../generated/prisma/client.js';
import { isUniqueViolation } from '../../infra/prisma/prisma-errors.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { AuditAction, AuditService } from '../audit/audit.service.js';
import { WalletsService } from '../wallets/wallets.service.js';
import { toDepositView, type DepositView } from './deposit.presenter.js';
import type { CreateDepositDto, SimulateDepositDto } from './dto/payments.dto.js';
import { PaymentProvidersRegistry } from './providers/payment-providers.registry.js';
import { WebhooksService } from './webhooks.service.js';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProvidersRegistry,
    private readonly webhooks: WebhooksService,
    private readonly wallets: WalletsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Start a top-up: create a PENDING deposit, then ask the provider for a
   * checkout URL. The Idempotency-Key maps to exactly ONE deposit (unique
   * per user), so retries return the same deposit and reference. If the
   * provider call failed earlier, a retry with the same key tries it again.
   * No money moves here; only a verified webhook credits the wallet.
   */
  async initiate(user: AuthUser, dto: CreateDepositDto, idempotencyKey: string, actor: Actor) {
    const amount = BigInt(dto.amount);
    const currency = dto.currency ?? this.config.get('DEFAULT_CURRENCY', { infer: true });
    const max = BigInt(this.config.get('MAX_TRANSACTION_AMOUNT', { infer: true }));
    if (amount > max) {
      throw AppException.unprocessable(
        ErrorCode.AMOUNT_TOO_LARGE,
        `The maximum deposit is ${max} minor units.`,
      );
    }
    this.wallets.assertSupportedCurrency(currency);
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId: user.id, currency } },
    });
    if (!wallet)
      throw AppException.notFound(
        ErrorCode.WALLET_NOT_FOUND,
        `You don't have a ${currency} wallet.`,
      );

    const provider = this.providers.active();
    let deposit: Deposit;
    try {
      deposit = await this.prisma.$transaction(async (tx) => {
        const created = await tx.deposit.create({
          data: {
            userId: user.id,
            walletId: wallet.id,
            provider: provider.name,
            reference: generateReference('DEP'),
            idempotencyKey,
            amount,
            currency,
          },
        });
        await this.audit.record(
          {
            action: AuditAction.DEPOSIT_INITIATED,
            actor,
            resourceType: 'deposit',
            resourceId: created.id,
            metadata: { amount: amount.toString(), currency, provider: provider.name },
          },
          tx,
        );
        return created;
      });
    } catch (err) {
      if (!isUniqueViolation(err, 'deposits_user_id_idempotency_key_key')) throw err;
      const existing = await this.prisma.deposit.findUniqueOrThrow({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
      });
      if (existing.amount !== amount || existing.currency !== currency) {
        throw AppException.unprocessable(
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          'This Idempotency-Key was already used for a different deposit. Use a new key.',
        );
      }
      if (existing.checkoutUrl) return { replayed: true, deposit: toDepositView(existing) };
      deposit = existing; // provider call failed last time: try again below
    }

    const { checkoutUrl } = await this.providers.get(deposit.provider).initiateDeposit({
      reference: deposit.reference,
      amount: deposit.amount,
      currency: deposit.currency,
      email: user.email,
    });
    const updated = await this.prisma.deposit.update({
      where: { id: deposit.id },
      data: { checkoutUrl },
    });
    return { replayed: false, deposit: toDepositView(updated) };
  }

  async list(userId: string, query: PaginationQueryDto) {
    const where = { userId };
    const [deposits, total] = await Promise.all([
      this.prisma.deposit.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...skipTake(query),
      }),
      this.prisma.deposit.count({ where }),
    ]);
    return { deposits: deposits.map(toDepositView), pagination: pageMeta(total, query) };
  }

  async get(userId: string, depositId: string): Promise<DepositView> {
    const deposit = await this.prisma.deposit.findFirst({ where: { id: depositId, userId } });
    if (!deposit) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Deposit not found.');
    return toDepositView(deposit);
  }

  /**
   * Development helper: play the sandbox provider for one of your own deposits.
   * Builds a correctly signed webhook and sends it through the REAL webhook
   * path, so it exercises exactly what production does. Disabled in production.
   */
  async simulate(userId: string, depositId: string, dto: SimulateDepositDto): Promise<DepositView> {
    const sandbox = this.providers.sandbox();
    if (this.config.get('isProduction', { infer: true }) || !sandbox) throw new NotFoundException();

    const deposit = await this.prisma.deposit.findFirst({ where: { id: depositId, userId } });
    if (!deposit || deposit.provider !== sandbox.name) {
      throw AppException.notFound(ErrorCode.NOT_FOUND, 'Sandbox deposit not found.');
    }

    const body = JSON.stringify({
      id: `evt_${randomBase32(20)}`,
      type: dto.outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
      data: {
        reference: deposit.reference,
        amount: Number(deposit.amount),
        currency: deposit.currency,
        ...(dto.outcome === 'failure' ? { failureReason: 'Card declined (simulated)' } : {}),
      },
    });
    const { timestamp, signature } = sandbox.sign(body);
    await this.webhooks.handle(sandbox.name, Buffer.from(body), {
      'x-sandbox-timestamp': timestamp,
      'x-sandbox-signature': signature,
    });
    return this.get(userId, depositId);
  }
}
