import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { ResponseMessage } from '../../common/decorators/http.decorators.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';
import { actorFrom, type AppRequest, type AuthUser } from '../../common/types/request.js';
import { UuidParam } from '../../common/validation/uuid-param.pipe.js';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import { WalletsService } from './wallets.service.js';

@ApiTags('Wallets')
@ApiBearerAuth()
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ResponseMessage('Wallet created successfully')
  @ApiOperation({ summary: 'Open a wallet (one per currency)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWalletDto, @Req() req: AppRequest) {
    return this.wallets.create(user.id, actorFrom(req), dto.currency);
  }

  @Get()
  @ResponseMessage('Wallets retrieved')
  @ApiOperation({ summary: 'List my wallets' })
  list(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.wallets.listMine(user.id, query);
  }

  @Get(':walletId/balance')
  @ResponseMessage('Wallet balance retrieved')
  @ApiOperation({
    summary: 'Wallet balance (owner only; read from the ledger-backed row, never a cache)',
  })
  balance(@CurrentUser() user: AuthUser, @UuidParam('walletId') walletId: string) {
    return this.wallets.getBalance(user.id, walletId);
  }
}
