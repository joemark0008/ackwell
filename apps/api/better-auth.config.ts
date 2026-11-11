// Used only by `npx @better-auth/cli generate` to emit the Drizzle tables. Not loaded at runtime.
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth } from './src/auth/auth.js';

export const auth = createAuth(drizzle('postgres://unused@localhost/unused') as never, {
  APP_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  NODE_ENV: 'development',
});
