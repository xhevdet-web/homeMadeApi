import { PartialType } from '@nestjs/swagger';
import { CreateGarmentDto } from './create-garment.dto.js';

export class UpdateGarmentDto extends PartialType(CreateGarmentDto) {}
