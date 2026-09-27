import { Body, Controller, Inject, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { UsersService } from './users.service.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.users.updateProfile(user.id, dto);
  }
}
