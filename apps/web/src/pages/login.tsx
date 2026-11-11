import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export function LoginPage({ initialEmail = '', notice }: { initialEmail?: string; notice?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) setError(error.status === 429 ? 'Too many attempts. Try again in a minute.' : 'Wrong email or password.');
  }

  return (
    <AuthLayout title="Sign in" description="Use your Ackwell account to manage channels.">
      <form onSubmit={onSubmit} aria-label="Sign in" noValidate>
        <FieldGroup>
          {notice && (
            <p role="status" className="rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
              {notice}
            </p>
          )}
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              autoFocus={!initialEmail}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus={!!initialEmail}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={busy || !email || !password} className="w-full">
            {busy && <Loader2 className="animate-spin" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}
