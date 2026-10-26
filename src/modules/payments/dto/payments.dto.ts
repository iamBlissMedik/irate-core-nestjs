import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { IsMinorAmount, Trim } from '../../../common/validation/validators.js';

export class CreateDepositDto {
  @ApiProperty({ example: 500000, description: 'Minor units: 500000 = NGN 5,000.00.' })
  @IsMinorAmount()
  amount: number;

  @ApiPropertyOptional({ example: 'NGN' })
  @IsOptional()
  @Trim()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code, e.g. NGN' })
  currency?: string;
}

export class SimulateDepositDto {
  @ApiProperty({ enum: ['success', 'failure'] })
  @IsIn(['success', 'failure'], { message: 'outcome must be success or failure' })
  outcome: 'success' | 'failure';
}
