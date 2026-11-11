import { useMemo } from 'react';
import { RouterProvider } from 'react-router';
import { authClient } from '@/lib/auth-client';
import { LoginPage } from '@/pages/login';
import { createRouter } from '@/router';
import { Logo } from '@/components/logo';

/** Gate: the login screen until there is a session, then the routed app. */
export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Logo className="animate-pulse" />
      </div>
    );
  }
  if (!session) return <LoginPage />;
  return <AuthedApp email={session.user.email} />;
}

function AuthedApp({ email }: { email: string }) {
  const router = useMemo(() => createRouter(email), [email]);
  return <RouterProvider router={router} />;
}
