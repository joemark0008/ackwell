import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { RouterProvider } from 'react-router';
import { Logo } from '@/components/logo';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { LoginPage } from '@/pages/login';
import { SetupPage } from '@/pages/setup';
import { createRouter } from '@/router';

/**
 * Gate: the first-run setup wizard while the server has no users, then the login screen until
 * there is a session, then the routed app.
 */
export function App() {
  const setup = useQuery({ queryKey: ['setup', 'status'], queryFn: api.setup.status, staleTime: Infinity, retry: false });
  const { data: session, isPending } = authClient.useSession();
  // Set when the wizard created the account but could not sign it in: fall through to login.
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);

  if (setup.isPending || isPending) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Logo className="animate-pulse" />
      </div>
    );
  }
  // If the status call itself failed, the API is down: the login page will say so on submit.
  if (setup.data?.needed && !createdEmail) return <SetupPage onCreated={setCreatedEmail} />;
  if (!session) {
    return createdEmail ? (
      <LoginPage initialEmail={createdEmail} notice="Admin account created. Sign in with your new password." />
    ) : (
      <LoginPage />
    );
  }
  return <AuthedApp email={session.user.email} />;
}

function AuthedApp({ email }: { email: string }) {
  const router = useMemo(() => createRouter(email), [email]);
  return <RouterProvider router={router} />;
}
