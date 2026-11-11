import { z } from 'zod';

/**
 * First-run setup wizard. While the user table is empty the API prints a one-time setup token to
 * its log; whoever can read the server log may create the first admin with it.
 */
export const setupTokenSchema = z.string().trim().min(8).max(64);

export const verifySetupTokenSchema = z.object({ token: setupTokenSchema });
export type VerifySetupTokenInput = z.input<typeof verifySetupTokenSchema>;

export const completeSetupSchema = z.object({
  token: setupTokenSchema,
  name: z.string().trim().min(1).max(80).default('Admin'),
  email: z.email().max(254),
  password: z.string().min(12, 'Use at least 12 characters').max(128),
});
export type CompleteSetupInput = z.input<typeof completeSetupSchema>;
export type CompleteSetup = z.output<typeof completeSetupSchema>;

export const setupStatusSchema = z.object({ needed: z.boolean() });
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const setupResultSchema = z.object({
  /** True when a session cookie was set in the same response. */
  signedIn: z.boolean(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});
export type SetupResult = z.infer<typeof setupResultSchema>;
