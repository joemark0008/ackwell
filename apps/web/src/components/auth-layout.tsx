import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';

/** Split layout shared by the sign-in page and the first-run setup wizard: brand panel + a form column. */
export function AuthLayout({
  title,
  description,
  above,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Rendered between the logo and the heading (e.g. a step indicator). */
  above?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-svh lg:grid-cols-[1fr_minmax(0,560px)]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden bg-zinc-950 p-12 text-zinc-100 lg:flex lg:flex-col">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.15] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_at_30%_40%,black,transparent_70%)]"
        />
        <Logo className="relative" />
        <div className="relative mt-auto max-w-lg space-y-6">
          <pre className="overflow-hidden rounded-lg border border-white/10 bg-white/5 p-4 font-mono text-[12px] leading-relaxed text-zinc-300">
            <span className="text-brand">MSH</span>|^~\&amp;|LAB|ACME|EHR|ACME|20261111080000||ORU^R01|MSG00042|P|2.5.1{'\n'}
            <span className="text-brand">PID</span>|1||12345^^^ACME||DOE^JANE{'\n'}
            <span className="text-brand">OBX</span>|1|NM|GLU^Glucose||5.4|mmol/L{'\n'}
            <span className="text-zinc-500">← </span>
            <span className="text-success">MSA|AA|MSG00042</span>
          </pre>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">HL7 v2 in, JSON out. And back.</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Run MLLP listeners, acknowledge every message after it is stored, and deliver clean JSON — or send JSON
              out as HL7 with retries and ACK tracking.
            </p>
          </div>
        </div>
      </section>

      {/* Form column */}
      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm space-y-8">
          <Logo className="lg:hidden" />
          {above}
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
