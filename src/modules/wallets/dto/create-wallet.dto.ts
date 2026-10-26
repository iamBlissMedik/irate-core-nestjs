import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { Trim } from '../../../common/validation/validators.js';

export class CreateWalletDto {
  @ApiPropertyOptional({
    example: 'NGN',
    description: 'ISO 4217 code; defaults to the platform currency.',
  })
  @IsOptional()
  @Trim()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code, e.g. NGN' })
  currency?: string;
}
