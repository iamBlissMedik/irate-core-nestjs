import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { HasNoControlChars, Trim } from '../../../common/validation/validators.js';
import { KycIdType, KycStatus } from '../../../generated/prisma/enums.js';

const MIN_AGE = 18;
const MAX_AGE = 120;

/** `YYYY-MM-DD` (or an ISO timestamp; only the date part is used) of someone 18-120 years old. */
function IsAdultBirthDate(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isAdultBirthDate',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: {
        message: `dateOfBirth must be a real date (YYYY-MM-DD) and you must be ${MIN_AGE}-${MAX_AGE} years old`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => {
          const dob = parseDateOnly(value);
          if (!dob) return false;
          const age = ageOn(dob, new Date());
          return age >= MIN_AGE && age <= MAX_AGE;
        },
      },
    });
}

/** Parses the date part of `YYYY-MM-DD...` as a UTC midnight Date, rejecting impossible dates (2001-02-30). */
export function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

function ageOn(dob: Date, today: Date): number {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export class SubmitKycDto {
  @ApiProperty({ example: 'Ada Okafor', minLength: 2, maxLength: 120 })
  @Trim()
  @IsString()
  @Length(2, 120)
  @HasNoControlChars()
  fullName: string;

  @ApiProperty({
    example: '1994-05-17',
    description: 'YYYY-MM-DD; applicant must be 18-120 years old.',
  })
  @IsString()
  @IsAdultBirthDate()
  dateOfBirth: string;

  @ApiProperty({ example: '12 Admiralty Way, Lekki, Lagos', minLength: 5, maxLength: 200 })
  @Trim()
  @IsString()
  @Length(5, 200)
  @HasNoControlChars()
  address: string;

  @ApiProperty({ enum: KycIdType })
  @IsEnum(KycIdType, { message: `idType must be one of ${Object.values(KycIdType).join(', ')}` })
  idType: KycIdType;

  @ApiProperty({ example: '12345678901', description: 'Exactly 11 digits for NIN and BVN.' })
  @Trim()
  @IsString()
  @Length(4, 40)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'idNumber may only contain letters, digits and "-"' })
  idNumber: string;

  @ApiPropertyOptional({ example: 'https://files.irate.dev/kyc/ada-nin.png', maxLength: 2048 })
  @IsOptional()
  @Trim()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'documentUrl must be an http(s) URL' },
  )
  @MaxLength(2048)
  documentUrl?: string;
}

export class ReviewKycDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] })
  @IsIn(['APPROVE', 'REJECT'], { message: 'action must be either APPROVE or REJECT' })
  action: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Stored as the rejection reason when rejecting.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  @HasNoControlChars()
  reason?: string;
}

export class ListKycQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: KycStatus })
  @IsOptional()
  @IsEnum(KycStatus, { message: `status must be one of ${Object.values(KycStatus).join(', ')}` })
  status?: KycStatus;
}
