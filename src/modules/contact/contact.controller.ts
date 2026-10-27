import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ContactService } from './contact.service.js';
import { CreateContactMessageDto } from './dto/create-contact-message.dto.js';

// Public (customers may be signed out); the throttler limits each client.
@Controller('contact')
@UseGuards(ThrottlerGuard)
export class ContactController {
  constructor(
    @Inject(ContactService) private readonly contact: ContactService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  send(@Body() dto: CreateContactMessageDto) {
    return this.contact.send(dto);
  }
}
