import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { HasNoControlChars, IsMinorAmount, Trim } from '../../../common/validation/validators.js';

export class TransferDto {
  @ApiProperty({ example: '1000000002', description: "Recipient's 10-digit account number." })
  @Trim()
  @IsString()
  @Matches(/^\d{10}$/, { message: 'toAccountNumber must be exactly 10 digits' })
  toAccountNumber: string;

  @ApiProperty({
    example: 250000,
    description: 'Minor units (kobo): 250000 = NGN 2,500.00. A JSON integer or an integer string.',
  })
  @IsMinorAmount()
  amount: number;

  @ApiPropertyOptional({ example: 'Rent share', maxLength: 140 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(140)
  @HasNoControlChars()
  note?: string;
}
