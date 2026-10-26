import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import {
  ApiIdempotencyKey,
  IdempotencyKey,
  ResponseMessage,
} from '../../common/decorators/http.decorators.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { ThrottlePolicy } from '../../common/throttling/throttle-policies.js';
import { actorFrom, type AppRequest, type AuthUser } from '../../common/types/request.js';
import { UuidParam } from '../../common/validation/uuid-param.pipe.js';
import { CreateDepositDto, SimulateDepositDto } from './dto/payments.dto.js';
import { PaymentsService } from './payments.service.js';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('deposits')
  @HttpCode(HttpStatus.CREATED)
  @ThrottlePolicy.moneyMovement()
  @ApiIdempotencyKey()
  @ResponseMessage('Deposit initiated')
  @ApiOperation({ summary: 'Start a wallet top-up (returns the provider checkout URL)' })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateDepositDto,
    @IdempotencyKey() key: string,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.payments.initiate(user, dto, key, actorFrom(req));
    if (result.replayed) res.status(HttpStatus.OK).setHeader('Idempotent-Replayed', 'true');
    return result.deposit;
  }

  @Get('deposits')
  @ResponseMessage('Deposits retrieved')
  @ApiOperation({ summary: 'My deposits (newest first)' })
  list(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.payments.list(user.id, query);
  }

  @Get('deposits/:depositId')
  @ResponseMessage('Deposit retrieved')
  @ApiOperation({ summary: 'One of my deposits' })
  get(@CurrentUser() user: AuthUser, @UuidParam('depositId') depositId: string) {
    return this.payments.get(user.id, depositId);
  }

  @Post('sandbox/deposits/:depositId/simulate')
  @HttpCode(HttpStatus.OK)
  @ResponseMessage('Deposit processed')
  @ApiOperation({ summary: 'DEV ONLY: settle a sandbox deposit through the real webhook path' })
  simulate(
    @CurrentUser() user: AuthUser,
    @UuidParam('depositId') depositId: string,
    @Body() dto: SimulateDepositDto,
  ) {
    return this.payments.simulate(user.id, depositId, dto);
  }
}
