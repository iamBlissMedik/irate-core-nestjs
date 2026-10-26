import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module.js';
import { StatementService } from './statement.service.js';
import { TransactionsController } from './transactions.controller.js';
import { TransfersService } from './transfers.service.js';

@Module({
  imports: [WalletsModule],
  controllers: [TransactionsController],
  providers: [TransfersService, StatementService],
  exports: [StatementService],
})
export class TransactionsModule {}
