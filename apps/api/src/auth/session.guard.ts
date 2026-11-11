import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { AUTH, type Auth } from './auth.js';
import { IS_PUBLIC } from './public.decorator.js';

export type SessionData = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
export type AuthedRequest = Request & { session?: SessionData };

/** Global guard: every route needs a Better Auth session unless marked @Public(). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      throw new UnauthorizedException({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Sign in required' });
    }
    req.session = session;
    return true;
  }
}
