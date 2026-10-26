import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';
import { HasNoControlChars, IsMinorAmount, Trim } from '../../../common/validation/validators.js';

export class CreditWalletDto {
  @ApiProperty({ example: 500000, description: 'Minor units: 500000 = NGN 5,000.00.' })
  @IsMinorAmount()
  amount: number;

  @ApiProperty({
    example: 'Goodwill: failed card refund',
    minLength: 1,
    maxLength: 200,
    description: "Shown on the customer's statement.",
  })
  @Trim()
  @IsString()
  @Length(1, 200, { message: 'reason must be 1-200 characters' })
  @HasNoControlChars()
  reason: string;
}

export class WalletStatusDto {
  @ApiProperty({
    enum: ['ACTIVE', 'FROZEN'],
    description: 'FROZEN = post-no-debit: can receive, cannot send.',
  })
  @IsIn(['ACTIVE', 'FROZEN'], { message: 'status must be ACTIVE or FROZEN' })
  status: 'ACTIVE' | 'FROZEN';

  @ApiProperty({ example: 'Suspicious activity under review', minLength: 1, maxLength: 200 })
  @Trim()
  @IsString()
  @Length(1, 200, { message: 'reason must be 1-200 characters' })
  @HasNoControlChars()
  reason: string;
}
