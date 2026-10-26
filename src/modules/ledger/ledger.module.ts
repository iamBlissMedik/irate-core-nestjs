import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SystemWalletsService } from './system-wallets.service.js';

@Global()
@Module({
  providers: [LedgerService, SystemWalletsService, ReconciliationService],
  exports: [LedgerService, SystemWalletsService, ReconciliationService],
})
export class LedgerModule {}
