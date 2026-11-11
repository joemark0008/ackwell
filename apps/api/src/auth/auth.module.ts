import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from '../config/env.js';
import { DB, type Db } from '../db/db.js';
import { AdminSeedService } from './admin-seed.service.js';
import { AUTH, createAuth } from './auth.js';
import { SessionGuard } from './session.guard.js';

@Global()
@Module({
  providers: [
    { provide: AUTH, inject: [DB, ENV], useFactory: (db: Db, env: Env) => createAuth(db, env) },
    { provide: APP_GUARD, useClass: SessionGuard },
    AdminSeedService,
  ],
  exports: [AUTH],
})
export class AuthModule {}
