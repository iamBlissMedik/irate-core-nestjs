import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import {
  ApiIdempotencyKey,
  IdempotencyKey,
  ResponseMessage,
} from '../../common/decorators/http.decorators.js';
import { AppException, ErrorCode } from '../../common/errors/app.exception.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { ThrottlePolicy } from '../../common/throttling/throttle-policies.js';
import { actorFrom, type AppRequest, type AuthUser } from '../../common/types/request.js';
import { UuidParam } from '../../common/validation/uuid-param.pipe.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { WalletsService } from '../wallets/wallets.service.js';
import { TransferDto } from './dto/transfer.dto.js';
import { StatementService } from './statement.service.js';
import { TransfersService } from './transfers.service.js';

@ApiTags('Transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly statements: StatementService,
    private readonly wallets: WalletsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('resolve/:accountNumber')
  @ThrottlePolicy.nameEnquiry()
  @ResponseMessage('Account resolved')
  @ApiOperation({ summary: "Name enquiry: confirm a recipient's name before paying" })
  resolve(@Param('accountNumber') accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'accountNumber must be exactly 10 digits.',
      );
    }
    return this.wallets.resolve(accountNumber);
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ThrottlePolicy.moneyMovement()
  @ApiIdempotencyKey()
  @ResponseMessage('Transfer successful')
  @ApiOperation({ summary: "Send money by account number (returns the sender's statement line)" })
  async transfer(
    @CurrentUser() user: AuthUser,
    @Body() dto: TransferDto,
    @IdempotencyKey() key: string,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.transfers.transfer(user, dto, key, actorFrom(req));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.entry;
  }

  @Get('me')
  @ResponseMessage('Transaction history retrieved')
  @ApiOperation({ summary: 'My statement across all my wallets (newest first)' })
  async mine(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId: user.id, kind: 'USER' },
      select: { id: true },
    });
    return this.statements.page(
      wallets.map((w) => w.id),
      query,
    );
  }

  @Get(':walletId/transactions')
  @ResponseMessage('Transaction history retrieved')
  @ApiOperation({ summary: "One wallet's statement (owner only)" })
  async forWallet(
    @CurrentUser() user: AuthUser,
    @UuidParam('walletId') walletId: string,
    @Query() query: PaginationQueryDto,
  ) {
    const wallet = await this.wallets.getOwned(user.id, walletId);
    return this.statements.page([wallet.id], query);
  }
}
