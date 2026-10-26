import { Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/auth.decorators.js';
import { ResponseMessage } from '../../common/decorators/http.decorators.js';
import type { AppRequest } from '../../common/types/request.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Inbound provider webhooks. Public (authenticated by HMAC signature over the
 * RAW body, not by a user token) and not rate limited: providers retry on
 * failure and we must not drop real payments.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Webhook processed')
  async receive(@Param('provider') provider: string, @Req() req: AppRequest) {
    await this.webhooks.handle(provider, req.rawBody, req.headers);
    return null;
  }
}
