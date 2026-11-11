import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { retentionRunSchema, retentionStatusSchema } from '@ackwell/schemas';
import { openApi } from '../common/zod.js';
import { RetentionService } from './retention.service.js';

@ApiTags('retention')
@Controller('retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @ApiOperation({ summary: 'Retention schedule, protected statuses and the last cleanup run.' })
  @ApiOkResponse({ schema: openApi(retentionStatusSchema, 'output') })
  status() {
    return this.retention.status();
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the cleanup now (deletes expired finished messages of every channel).' })
  @ApiOkResponse({ schema: openApi(retentionRunSchema, 'output') })
  run() {
    return this.retention.run('manual');
  }
}
