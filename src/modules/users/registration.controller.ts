import { Body, Controller, Inject, Post } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';

// Public self-registration. UsersService.create always assigns the CUSTOMER role, so
// visitors cannot create privileged accounts; POST /users stays admin-only.
@Controller('auth')
export class RegistrationController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Post('register')
  register(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }
}
