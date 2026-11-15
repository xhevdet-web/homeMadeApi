import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CreateSavedDesignDto,
  DuplicateSavedDesignDto,
  UpdateSavedDesignDto,
} from './dto/saved-design.dto.js';
import { SavedDesignsService } from './saved-designs.service.js';

/** The signed-in customer's own saved designs ("My designs"); no route accepts a user id. */
@ApiTags('saved-designs')
@ApiBearerAuth()
@Controller('saved-designs')
@UseGuards(JwtAuthGuard)
export class SavedDesignsController {
  constructor(
    @Inject(SavedDesignsService)
    private readonly service: SavedDesignsService,
  ) {}

  @Get()
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.service.findMine(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.findOne(user.id, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSavedDesignDto,
  ) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSavedDesignDto,
  ) {
    return this.service.update(user.id, id, dto);
  }

  @Post(':id/duplicate')
  duplicate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DuplicateSavedDesignDto,
  ) {
    return this.service.duplicate(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.remove(user.id, id);
  }
}
