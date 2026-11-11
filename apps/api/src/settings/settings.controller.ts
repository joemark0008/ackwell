import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { appSettingsSchema, type AppSettings } from '@ackwell/schemas';
import { openApi } from '../common/zod.js';
import { ENV, type Env } from '../config/env.js';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get()
  @ApiOkResponse({ schema: openApi(appSettingsSchema, 'output') })
  get(): AppSettings {
    return {
      mllp: { host: this.env.MLLP_ADVERTISED_HOST, portRange: this.env.MLLP_PORT_RANGE },
      retentionDefaultDays: this.env.RETENTION_DEFAULT_DAYS,
      files: { enabled: Boolean(this.env.FILE_ROOT) },
    };
  }
}
