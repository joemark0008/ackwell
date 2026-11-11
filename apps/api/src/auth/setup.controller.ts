import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  completeSetupSchema,
  setupResultSchema,
  setupStatusSchema,
  verifySetupTokenSchema,
  type CompleteSetup,
  type SetupResult,
  type SetupStatus,
  type VerifySetupTokenInput,
} from '@ackwell/schemas';
import type { Request, Response } from 'express';
import { openApi, ZodPipe } from '../common/zod.js';
import { Public } from './public.decorator.js';
import { SetupService } from './setup.service.js';

/** First-run setup wizard. Public: there is no account yet to sign in with. */
@ApiTags('setup')
@Controller('setup')
@Public()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  @ApiOperation({ summary: 'Whether the first-run setup wizard still has to run (no users yet)' })
  @ApiOkResponse({ schema: openApi(setupStatusSchema, 'output') })
  async status(): Promise<SetupStatus> {
    return { needed: await this.setup.isNeeded() };
  }

  @Post('verify')
  @HttpCode(204)
  @ApiOperation({ summary: 'Check a setup token (401 SETUP_TOKEN_INVALID, 409 SETUP_DONE)' })
  @ApiBody({ schema: openApi(verifySetupTokenSchema) })
  @ApiNoContentResponse()
  async verify(@Body(new ZodPipe(verifySetupTokenSchema)) body: VerifySetupTokenInput): Promise<void> {
    await this.setup.verifyToken(body.token);
  }

  @Post('complete')
  @ApiOperation({ summary: 'Create the first admin with the setup token and sign them in' })
  @ApiBody({ schema: openApi(completeSetupSchema) })
  @ApiCreatedResponse({ schema: openApi(setupResultSchema, 'output') })
  async complete(
    @Body(new ZodPipe(completeSetupSchema)) body: CompleteSetup,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SetupResult> {
    const r = await this.setup.complete(body, req.headers);
    if (r.setCookies.length > 0) res.setHeader('set-cookie', r.setCookies);
    return { signedIn: r.setCookies.length > 0, user: r.user };
  }
}
