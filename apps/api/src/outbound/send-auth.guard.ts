import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { AUTH, type Auth } from '../auth/auth.js';
import type { AuthedRequest } from '../auth/session.guard.js';
import { ApiKeysService } from './api-keys.service.js';

export type SendRequest = AuthedRequest & { apiKeyId?: string };

/**
 * Auth for POST /channels/:id/send: a per-channel API key (`Authorization: Bearer ak_…`) for machines,
 * or a Better Auth session for the dashboard. The route is marked @Public() so the global guard
 * defers to this one.
 */
@Injectable()
export class SendAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly keys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SendRequest>();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const channelId = String(req.params.id ?? '');
      const row = await this.keys.authenticate(channelId, header.slice(7).trim());
      if (!row) {
        throw new UnauthorizedException({ statusCode: 401, code: 'INVALID_API_KEY', message: 'Unknown or revoked API key' });
      }
      req.apiKeyId = row.id;
      return true;
    }
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: 'Send an API key (Authorization: Bearer ak_…) or sign in',
      });
    }
    req.session = session;
    return true;
  }
}
