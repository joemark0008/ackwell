import { Check, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

const STEPS = ['Setup token', 'Admin account', 'Done'] as const;
const MIN_PASSWORD = 12;

export interface SetupPageProps {
  /** Called when the account exists and a session cookie was set. Defaults to a full reload into the app. */
  onSignedIn?: () => void;
  /** Called when the account exists but no session was set: show the sign-in page for this email. */
  onCreated?: (email: string) => void;
}

/**
 * First-run wizard. The API printed a one-time token to its log when it started with no users;
 * whoever can read that log creates the first admin here.
 */
export function SetupPage({ onSignedIn = () => window.location.assign('/'), onCreated }: SetupPageProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  function fail(e: unknown, fallback: string) {
    if (e instanceof ApiError) {
      if (e.code === 'SETUP_DONE') {
        // Someone else finished the wizard: hand over to the normal sign-in.
        window.location.assign('/');
        return;
      }
      if (e.code === 'SETUP_TOKEN_INVALID') {
        setStep(1);
        setError('Wrong setup token. After five wrong attempts the server prints a new one in its log.');
        return;
      }
      if (e.code === 'VALIDATION_ERROR' && e.body?.issues?.length) {
        setError(e.body.issues.map((i) => `${i.path}: ${i.message}`).join(' · '));
        return;
      }
      if (e.status === 429) {
        setError('Too many attempts. Try again in a minute.');
        return;
      }
    }
    setError(fallback);
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup.verify(token);
      setStep(2);
    } catch (err) {
      fail(err, 'Could not reach the server. Check that the API is running and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function complete(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters for the password.`);
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const r = await api.setup.complete({ token, name: name.trim() || 'Admin', email: email.trim(), password });
      setSignedIn(r.signedIn);
      setStep(3);
      if (r.signedIn) onSignedIn();
      else onCreated?.(r.user.email);
    } catch (err) {
      fail(err, 'Could not create the account. Check the API log and try again.');
    } finally {
      setBusy(false);
    }
  }

  const stepIndicator = (
    <ol aria-label="Setup progress" className="flex items-center gap-2 text-xs text-muted-foreground">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <li key={label} aria-current={state === 'current' ? 'step' : undefined} className="flex items-center gap-2">
            <span
              className={cn(
                'grid size-5 place-items-center rounded-full border text-[11px] font-medium tabular-nums',
                state === 'done' && 'border-brand bg-brand text-brand-foreground',
                state === 'current' && 'border-foreground text-foreground',
              )}
            >
              {state === 'done' ? <Check className="size-3" aria-hidden /> : n}
            </span>
            <span className={cn(state === 'current' && 'font-medium text-foreground')}>{label}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="h-px w-5 bg-border" />}
          </li>
        );
      })}
    </ol>
  );

  const errorBox = error && (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  );

  if (step === 1) {
    return (
      <AuthLayout
        above={stepIndicator}
        title="Set up Ackwell"
        description="This server has no admin user yet. Prove you run it by entering the setup token from the API log."
      >
        <form onSubmit={verify} aria-label="Setup token" noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-token">Setup token</FieldLabel>
              <Input
                id="setup-token"
                autoFocus
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                className="font-mono uppercase tracking-wider"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <FieldDescription>
                Printed in a box headed <span className="font-mono">Ackwell first-run setup</span> when the API started.
                In Coolify open the service's <b>Logs</b>; with Docker run <span className="font-mono">docker logs &lt;container&gt;</span>.
                Restarting the API prints a new token.
              </FieldDescription>
            </Field>
            {errorBox}
            <Button type="submit" size="lg" disabled={busy || token.trim().length < 8} className="w-full">
              {busy && <Loader2 className="animate-spin" />}
              {busy ? 'Checking…' : 'Continue'}
            </Button>
          </FieldGroup>
        </form>
      </AuthLayout>
    );
  }

  if (step === 2) {
    return (
      <AuthLayout
        above={stepIndicator}
        title="Create the admin account"
        description="This is the first user. More can be added later from the dashboard."
      >
        <form onSubmit={complete} aria-label="Admin account" noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="setup-name">Name</FieldLabel>
              <Input id="setup-name" autoFocus autoComplete="name" placeholder="Admin" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-email">Email</FieldLabel>
              <Input
                id="setup-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-password">Password</FieldLabel>
              <Input
                id="setup-password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <FieldDescription>At least {MIN_PASSWORD} characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="setup-confirm">Confirm password</FieldLabel>
              <Input
                id="setup-confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            {errorBox}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="lg" disabled={busy} onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit" size="lg" disabled={busy || !email || !password || !confirm} className="flex-1">
                {busy && <Loader2 className="animate-spin" />}
                {busy ? 'Creating…' : 'Create admin'}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      above={stepIndicator}
      title="Ackwell is ready"
      description={
        signedIn
          ? 'Your admin account was created and you are signed in. Opening the dashboard…'
          : 'Your admin account was created. Sign in with the password you just chose.'
      }
    >
      {signedIn ? (
        <Loader2 className="animate-spin text-muted-foreground" aria-label="Loading" />
      ) : (
        <Button size="lg" className="w-full" onClick={() => (onCreated ? onCreated(email) : window.location.assign('/'))}>
          Go to sign in
        </Button>
      )}
    </AuthLayout>
  );
}
