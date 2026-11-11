import type { Channel } from '@ackwell/schemas';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getJson } from './lib/api';
import { authClient } from './lib/auth-client';
import { Login } from './Login';

/** Gate: show the login screen until there is a session. */
export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <p className="p-6 font-sans text-slate-500">Loading…</p>;
  if (!session) return <Login />;
  return <Dashboard email={session.user.email} />;
}

/** Phase 1 placeholder: shows API health and channels. The real UI is built in Phase 4. */
function Dashboard({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => getJson<{ status: string; db: string }>('/health'),
    refetchInterval: 10_000,
  });
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => getJson<Channel[]>('/api/channels') });

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
  }

  return (
    <main className="mx-auto max-w-3xl p-6 font-sans text-slate-800">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Ackwell</h1>
          <p className="text-slate-500">HL7 v2 channels — inbound MLLP → JSON, outbound JSON → HL7.</p>
        </div>
        <div className="text-right text-sm">
          <p className="text-slate-500">{email}</p>
          <button onClick={signOut} className="text-blue-700 underline">
            Sign out
          </button>
        </div>
      </header>

      <section className="mt-6 rounded border p-4">
        <h2 className="font-medium">API</h2>
        <p>
          Health:{' '}
          {health.isPending ? (
            '…'
          ) : health.isError ? (
            <span className="text-red-600">unreachable</span>
          ) : (
            <span className="text-green-700">
              {health.data.status} (db {health.data.db})
            </span>
          )}
        </p>
        <a className="text-blue-700 underline" href="/api/docs">
          OpenAPI docs
        </a>
      </section>

      <section className="mt-6 rounded border p-4">
        <h2 className="font-medium">Channels</h2>
        {channels.isPending && <p>Loading…</p>}
        {channels.isError && <p className="text-red-600">{String(channels.error)}</p>}
        {channels.data?.length === 0 && <p className="text-slate-500">No channels yet.</p>}
        <ul>
          {channels.data?.map((c) => (
            <li key={c.id}>
              {c.name} — {c.direction} — {c.status}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
