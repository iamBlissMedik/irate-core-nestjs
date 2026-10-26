import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { ResponseMessage } from '../../common/decorators/http.decorators.js';
import { actorFrom, type AppRequest, type AuthUser } from '../../common/types/request.js';
import { SubmitKycDto } from './dto/kyc.dto.js';
import { KycService } from './kyc.service.js';

@ApiTags('KYC')
@ApiBearerAuth()
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post('submit')
  @HttpCode(HttpStatus.CREATED)
  @ResponseMessage('KYC submitted successfully')
  @ApiOperation({ summary: 'Submit (or re-submit after rejection) KYC details' })
  submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitKycDto, @Req() req: AppRequest) {
    return this.kyc.submit(user.id, dto, actorFrom(req));
  }

  @Get('status')
  @ResponseMessage('KYC retrieved')
  @ApiOperation({ summary: 'My KYC record (404 KYC_NOT_FOUND if nothing was submitted)' })
  status(@CurrentUser() user: AuthUser) {
    return this.kyc.getMine(user.id);
  }
}
