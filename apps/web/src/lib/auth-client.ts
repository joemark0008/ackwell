import { createAuthClient } from 'better-auth/react';

/** Better Auth client; the API serves it at /api/auth on the same origin (Vite proxies it in dev). */
export const authClient = createAuthClient({ baseURL: window.location.origin, basePath: '/api/auth' });
