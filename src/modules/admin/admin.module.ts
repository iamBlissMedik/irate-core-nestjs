import { Module } from '@nestjs/common';
import { KycModule } from '../kyc/kyc.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminStatsService } from './admin-stats.service.js';
import { AdminWalletsService } from './admin-wallets.service.js';
import { AdminController } from './admin.controller.js';

@Module({
  imports: [UsersModule, KycModule],
  controllers: [AdminController],
  providers: [AdminStatsService, AdminWalletsService],
})
export class AdminModule {}
