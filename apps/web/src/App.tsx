import type { Channel } from '@ackwell/schemas';
import { useQuery } from '@tanstack/react-query';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** Phase 1 placeholder: shows API health and channels. The real UI is built in Phase 4. */
export function App() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => getJson<{ status: string; db: string }>('/health'), refetchInterval: 10_000 });
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => getJson<Channel[]>('/api/channels') });

  return (
    <main className="mx-auto max-w-3xl p-6 font-sans text-slate-800">
      <h1 className="text-2xl font-semibold">Ackwell</h1>
      <p className="text-slate-500">HL7 v2 channels — inbound MLLP → JSON, outbound JSON → HL7.</p>

      <section className="mt-6 rounded border p-4">
        <h2 className="font-medium">API</h2>
        <p>
          Health:{' '}
          {health.isPending ? '…' : health.isError ? <span className="text-red-600">unreachable</span> : <span className="text-green-700">{health.data.status} (db {health.data.db})</span>}
        </p>
        <a className="text-blue-700 underline" href="/api/docs">OpenAPI docs</a>
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
