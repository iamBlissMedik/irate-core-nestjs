import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../../common/decorators/auth.decorators.js';
import {
  ApiIdempotencyKey,
  IdempotencyKey,
  ResponseMessage,
} from '../../common/decorators/http.decorators.js';
import { actorFrom, type AppRequest, type AuthUser } from '../../common/types/request.js';
import { UuidParam } from '../../common/validation/uuid-param.pipe.js';
import { ListKycQueryDto, ReviewKycDto } from '../kyc/dto/kyc.dto.js';
import { KycService } from '../kyc/kyc.service.js';
import { ReconciliationService } from '../ledger/reconciliation.service.js';
import { ListUsersQueryDto } from '../users/dto/list-users.dto.js';
import { UsersService } from '../users/users.service.js';
import { AdminStatsService } from './admin-stats.service.js';
import { AdminWalletsService } from './admin-wallets.service.js';
import { CreditWalletDto, WalletStatusDto } from './dto/admin.dto.js';

@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly stats: AdminStatsService,
    private readonly wallets: AdminWalletsService,
    private readonly users: UsersService,
    private readonly kyc: KycService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('dashboard/overview')
  @ResponseMessage('Dashboard overview fetched successfully')
  @ApiOperation({ summary: 'All dashboard stat cards' })
  overview() {
    return this.stats.overview();
  }

  @Get('me')
  @ResponseMessage('Admin fetched successfully')
  @ApiOperation({ summary: 'My admin profile' })
  me(@CurrentUser() admin: AuthUser) {
    return this.users.getProfile(admin, admin.id);
  }

  @Get('users')
  @ResponseMessage('Users retrieved successfully')
  @ApiOperation({ summary: 'User directory (search by email or KYC name, paginated)' })
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.users.listForAdmin(query);
  }

  @Get('users/stats')
  @ResponseMessage('User stats fetched successfully')
  @ApiOperation({ summary: 'Total customers and today-vs-yesterday sign-up trend' })
  userStats() {
    return this.stats.usersStats();
  }

  @Get('wallets/balance')
  @ResponseMessage('Wallet balance stats fetched successfully')
  @ApiOperation({ summary: 'Total customer balances and inflow trend' })
  walletsBalance() {
    return this.stats.walletsBalance();
  }

  @Post('credit/:walletId')
  @HttpCode(HttpStatus.OK)
  @ApiIdempotencyKey()
  @ResponseMessage('Wallet credited successfully')
  @ApiOperation({ summary: 'Credit a customer wallet (balanced against the ADJUSTMENTS account)' })
  async credit(
    @CurrentUser() admin: AuthUser,
    @UuidParam('walletId') walletId: string,
    @Body() dto: CreditWalletDto,
    @IdempotencyKey() key: string,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { replayed, result } = await this.wallets.credit(
      admin,
      walletId,
      dto,
      key,
      actorFrom(req),
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result;
  }

  @Patch('wallets/:walletId/status')
  @ResponseMessage('Wallet status updated')
  @ApiOperation({ summary: 'Freeze (post-no-debit) or unfreeze a customer wallet' })
  setWalletStatus(
    @UuidParam('walletId') walletId: string,
    @Body() dto: WalletStatusDto,
    @Req() req: AppRequest,
  ) {
    return this.wallets.setStatus(walletId, dto, actorFrom(req));
  }

  @Get('kyc')
  @ResponseMessage('KYC submissions retrieved')
  @ApiOperation({ summary: 'KYC queue (filter by status, paginated)' })
  listKyc(@Query() query: ListKycQueryDto) {
    return this.kyc.list(query);
  }

  @Patch('kyc/:kycId/review')
  @ResponseMessage('KYC reviewed')
  @ApiOperation({ summary: 'Approve or reject a PENDING KYC submission (decisions are final)' })
  async reviewKyc(
    @CurrentUser() admin: AuthUser,
    @UuidParam('kycId') kycId: string,
    @Body() dto: ReviewKycDto,
    @Req() req: AppRequest,
  ) {
    return this.kyc.review(kycId, dto, { ...actorFrom(req), userId: admin.id });
  }

  @Get('reconciliation')
  @ResponseMessage('Reconciliation completed')
  @ApiOperation({
    summary: 'Check ledger invariants (balanced journals, wallet = ledger, currencies net to zero)',
  })
  reconcile() {
    return this.reconciliation.run();
  }
}
