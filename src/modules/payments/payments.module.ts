import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentProvidersRegistry } from './providers/payment-providers.registry.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({
  imports: [WalletsModule],
  controllers: [PaymentsController, WebhooksController],
  providers: [PaymentsService, WebhooksService, PaymentProvidersRegistry],
})
export class PaymentsModule {}
