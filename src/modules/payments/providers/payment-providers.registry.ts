import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, ErrorCode } from '../../../common/errors/app.exception.js';
import type { Env } from '../../../config/env.js';
import type { PaymentProvider } from './payment-provider.js';
import { PaystackProvider } from './paystack.provider.js';
import { SandboxProvider } from './sandbox.provider.js';

/**
 * Builds the configured providers. The ACTIVE provider (PAYMENTS_PROVIDER)
 * handles new deposits. Outside production the sandbox is always registered
 * too, so local testing keeps working while Paystack is active.
 */
@Injectable()
export class PaymentProvidersRegistry {
  private readonly providers = new Map<string, PaymentProvider>();
  private readonly activeName: string;

  constructor(config: ConfigService<Env, true>) {
    this.activeName = config.get('PAYMENTS_PROVIDER', { infer: true });
    const isProduction = config.get('isProduction', { infer: true });

    if (this.activeName === 'sandbox' || !isProduction) {
      this.providers.set(
        'sandbox',
        new SandboxProvider(
          config.get('SANDBOX_WEBHOOK_SECRET', { infer: true }),
          config.get('PUBLIC_API_URL', { infer: true }),
        ),
      );
    }
    const paystackKey = config.get('PAYSTACK_SECRET_KEY', { infer: true });
    if (paystackKey && (this.activeName === 'paystack' || !isProduction)) {
      this.providers.set(
        'paystack',
        new PaystackProvider(
          paystackKey,
          config.get('PAYSTACK_BASE_URL', { infer: true }),
          config.get('PAYSTACK_CALLBACK_URL', { infer: true }),
        ),
      );
    }
  }

  active(): PaymentProvider {
    return this.providers.get(this.activeName)!;
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw AppException.notFound(ErrorCode.NOT_FOUND, 'Unknown payment provider.');
    return provider;
  }

  sandbox(): SandboxProvider | undefined {
    return this.providers.get('sandbox') as SandboxProvider | undefined;
  }
}
