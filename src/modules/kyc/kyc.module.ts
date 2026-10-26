import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller.js';
import { KycService } from './kyc.service.js';

@Module({
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
