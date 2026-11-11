// Better Auth core tables. Generated with `npx @better-auth/cli generate --config better-auth.config.ts`
// (v1.7.20), then renamed (auth*) and switched to timestamptz. Regenerate after adding auth plugins.
import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const authUser = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: ts('created_at').defaultNow().notNull(),
  updatedAt: ts('updated_at').defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const authSession = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').$onUpdate(() => new Date()).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
);

export const authAccount = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
);

export const authVerification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').defaultNow().notNull(),
    updatedAt: ts('updated_at').defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const authUserRelations = relations(authUser, ({ many }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
}));
export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(authUser, { fields: [authSession.userId], references: [authUser.id] }),
}));
export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(authUser, { fields: [authAccount.userId], references: [authUser.id] }),
}));
