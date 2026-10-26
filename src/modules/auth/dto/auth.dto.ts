import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { NormalizeEmail } from '../../../common/validation/validators.js';

export class RegisterDto {
  @ApiProperty({ example: 'ada@irate.dev', maxLength: 254 })
  @NormalizeEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email: string;

  @ApiProperty({
    example: 'Password123!',
    minLength: 8,
    maxLength: 128,
    description: 'At least one upper-case letter, one lower-case letter and one digit.',
  })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  @Matches(/[a-z]/, { message: 'password must include a lower-case letter' })
  @Matches(/[A-Z]/, { message: 'password must include an upper-case letter' })
  @Matches(/[0-9]/, { message: 'password must include a number' })
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@irate.dev' })
  @NormalizeEmail()
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(1, { message: 'password is required' })
  @MaxLength(128)
  password: string;
}
