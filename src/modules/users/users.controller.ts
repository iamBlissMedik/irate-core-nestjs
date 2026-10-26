import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { ResponseMessage } from '../../common/decorators/http.decorators.js';
import type { AuthUser } from '../../common/types/request.js';
import { UuidParam } from '../../common/validation/uuid-param.pipe.js';
import { UsersService } from './users.service.js';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Static routes are declared before `:userId` so "me" is never parsed as an id.
  @Get('me/overview')
  @ResponseMessage('Overview fetched successfully')
  @ApiOperation({ summary: 'Customer home screen: balance, KYC status, stats and recent activity' })
  overview(@CurrentUser() user: AuthUser) {
    return this.users.getOverview(user.id);
  }

  @Get('me')
  @ResponseMessage('User fetched successfully')
  @ApiOperation({ summary: 'My profile' })
  me(@CurrentUser() user: AuthUser) {
    return this.users.getProfile(user, user.id);
  }

  @Get(':userId')
  @ResponseMessage('User fetched successfully')
  @ApiOperation({ summary: "A user's profile (yourself, or anyone for admins)" })
  byId(@CurrentUser() user: AuthUser, @UuidParam('userId') userId: string) {
    return this.users.getProfile(user, userId);
  }
}
