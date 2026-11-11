import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupPage } from './setup';

const GOOD = 'ABCDE-FGHJK-MNPQR-STVWX';

function mockApi() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/api/setup/verify')) {
        // The server normalizes case and separators; the mock mirrors that.
        return String(body.token).toUpperCase() === GOOD
          ? new Response(null, { status: 204 })
          : Response.json({ statusCode: 401, code: 'SETUP_TOKEN_INVALID', message: 'Wrong setup token' }, { status: 401 });
      }
      if (url.endsWith('/api/setup/complete')) {
        return Response.json(
          { signedIn: true, user: { id: 'u1', email: body.email, name: body.name } },
          { status: 201, headers: { 'set-cookie': 'better-auth.session_token=x' } },
        );
      }
      return Response.json({}, { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('SetupPage', () => {
  it('rejects a wrong token and stays on step 1', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<SetupPage onSignedIn={() => {}} />);

    await user.type(screen.getByLabelText('Setup token', { selector: 'input' }), 'WRONG-WRONG-WRONG-WRONG');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong setup token');
    expect(screen.getByRole('form', { name: 'Setup token' })).toBeInTheDocument();
  });

  it('verifies the token, creates the admin and hands over when signed in', async () => {
    const calls = mockApi();
    const onSignedIn = vi.fn();
    const user = userEvent.setup();
    render(<SetupPage onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText('Setup token', { selector: 'input' }), GOOD.toLowerCase());
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('form', { name: 'Admin account' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name', { selector: 'input' }), 'Ops');
    await user.type(screen.getByLabelText('Email', { selector: 'input' }), 'ops@ackwell.test');
    await user.type(screen.getByLabelText('Password', { selector: 'input' }), 'correct-horse-battery');
    await user.type(screen.getByLabelText('Confirm password', { selector: 'input' }), 'correct-horse-batter'); // typo
    await user.click(screen.getByRole('button', { name: 'Create admin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(0);

    await user.type(screen.getByLabelText('Confirm password', { selector: 'input' }), 'y');
    await user.click(screen.getByRole('button', { name: 'Create admin' }));

    expect(await screen.findByRole('heading', { name: 'Ackwell is ready' })).toBeInTheDocument();
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    const complete = calls.find((c) => c.url.endsWith('/complete'))!;
    expect(complete.body).toEqual({ token: GOOD.toLowerCase(), name: 'Ops', email: 'ops@ackwell.test', password: 'correct-horse-battery' });
  });
});
