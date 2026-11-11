import { FILE_NAME_PRESETS, renderFileName, type ChannelDirection, type ChannelTransport, type FolderCheck } from '@ackwell/schemas';
import { CheckCircle2, FolderOpen, Loader2, Network, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Controller, useWatch, type Control, type UseFormRegister } from 'react-hook-form';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';
import type { ChannelFormValues } from '@/lib/channel-form';
import { cn } from '@/lib/utils';

type Err = (n: string) => { message?: string } | undefined;
type Invalid = (n: string) => boolean | undefined;
interface FieldProps {
  control: Control<ChannelFormValues>;
  register: UseFormRegister<ChannelFormValues>;
  err: Err;
  invalid: Invalid;
  disabled?: boolean;
}

/** MLLP vs shared folder (create only). Folder is disabled when the server has no FILE_ROOT. */
export function TransportPicker({
  direction,
  value,
  filesEnabled,
}: {
  direction: ChannelDirection;
  value: ChannelTransport;
  filesEnabled: boolean;
}) {
  const opts = [
    {
      v: 'mllp' as const,
      icon: Network,
      title: 'MLLP (network)',
      body: direction === 'inbound' ? 'Senders connect to a port' : 'Send to a host and port, wait for the ACK',
    },
    {
      v: 'file' as const,
      icon: FolderOpen,
      title: 'Shared folder',
      body: direction === 'inbound' ? 'Pick up .hl7 files from a folder' : 'Write .hl7 files into a folder',
    },
  ];
  return (
    <div role="radiogroup" aria-label="Connection type" className="grid gap-3 sm:grid-cols-2">
      {opts.map(({ v, icon: Icon, title, body }) => {
        const active = v === value;
        const off = v === 'file' && !filesEnabled;
        const cls = cn(
          'flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          active ? 'border-brand ring-1 ring-brand' : 'hover:bg-muted/40',
          off && 'pointer-events-none opacity-50',
        );
        const inner = (
          <>
            <Icon className="mt-0.5 size-4 text-brand" />
            <span>
              <span className="block text-sm font-medium">{title}</span>
              <span className="block text-xs text-muted-foreground">
                {off ? 'Not available: the server has no shared folder (FILE_ROOT) mounted' : body}
              </span>
            </span>
          </>
        );
        return off ? (
          <div key={v} role="radio" aria-checked={false} aria-disabled className={cls}>
            {inner}
          </div>
        ) : (
          <Link key={v} to={`/channels/new?direction=${direction}&transport=${v}`} replace role="radio" aria-checked={active} className={cls}>
            {inner}
          </Link>
        );
      })}
    </div>
  );
}

/** A folder input (relative to the shared root) with a "Check" button. */
function FolderField({
  id,
  label,
  name,
  help,
  register,
  err,
  invalid,
  disabled,
  control,
}: FieldProps & { id: string; label: string; name: 'config.directory' | 'config.processedDirectory' | 'config.errorDirectory'; help?: string }) {
  const value = useWatch({ control, name });
  const [check, setCheck] = useState<FolderCheck | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      setCheck(await api.channels.checkFolder(value.trim()));
    } catch (e) {
      setCheck({ error: e instanceof ApiError ? (e.body?.issues?.[0]?.message ?? e.message) : 'Check failed' });
    } finally {
      setBusy(false);
    }
  }
  const ok = check && 'exists' in check && check.exists && check.readable && check.writable;
  return (
    <Field data-invalid={invalid(name)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-muted-foreground">root/</span>
        <Input id={id} className="font-mono text-sm" disabled={disabled} aria-invalid={invalid(name)} {...register(name, { onChange: () => setCheck(null) })} />
        <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy || !value?.trim()}>
          {busy && <Loader2 className="animate-spin" />}
          Check
        </Button>
      </div>
      {check && (
        <p role="status" className={cn('flex items-center gap-1.5 text-xs', ok ? 'text-success' : 'text-muted-foreground')}>
          {ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
          {ok
            ? `Found · readable and writable · ${(check as FolderCheck).entries ?? 0} item(s)`
            : check.error ?? 'Not usable'}
        </p>
      )}
      {help && <FieldDescription>{help}</FieldDescription>}
      <FieldError errors={[err(name)]} />
    </Field>
  );
}

function NumberField({ id, label, name, help, register, err, invalid, disabled }: Omit<FieldProps, 'control'> & {
  id: string;
  label: string;
  name: 'config.stableMs' | 'config.pollIntervalMs';
  help?: string;
}) {
  return (
    <Field data-invalid={invalid(name)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} inputMode="numeric" className="w-32 font-mono" disabled={disabled} aria-invalid={invalid(name)} {...register(name)} />
      {help && <FieldDescription>{help}</FieldDescription>}
      <FieldError errors={[err(name)]} />
    </Field>
  );
}

/** Inbound file channel: watched / processed / error folders and pickup rules. */
export function InboundFileFields(p: FieldProps) {
  const polling = useWatch({ control: p.control, name: 'config.usePolling' });
  return (
    <>
      <FolderField id="directory" label="Watched folder (results)" name="config.directory" help="The LIS saves result files here. Created when the channel starts." {...p} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FolderField id="processedDirectory" label="Processed folder" name="config.processedDirectory" help="Imported files are moved here." {...p} />
        <FolderField id="errorDirectory" label="Error folder" name="config.errorDirectory" help="Bad files go here with a .error.txt reason." {...p} />
      </div>
      <Field data-invalid={p.invalid('config.includeText')}>
        <FieldLabel htmlFor="include">File types</FieldLabel>
        <Input id="include" className="w-60 font-mono text-sm" disabled={p.disabled} aria-invalid={p.invalid('config.includeText')} {...p.register('config.includeText')} />
        <FieldDescription>Patterns, comma separated. One HL7 message per file.</FieldDescription>
        <FieldError errors={[p.err('config.includeText')]} />
      </Field>
      <NumberField
        id="stableMs"
        label="Finished after (ms) unchanged"
        name="config.stableMs"
        help="A file is read only once its size has not changed for this long, so half-written files are never imported."
        {...p}
      />
      <Controller
        control={p.control}
        name="config.usePolling"
        render={({ field }) => (
          <Field orientation="horizontal" className="rounded-lg border p-3">
            <div className="flex-1 space-y-0.5">
              <FieldLabel htmlFor="usePolling">Poll the folder</FieldLabel>
              <FieldDescription>Keep on for network shares: they do not report files written by other machines.</FieldDescription>
            </div>
            <Switch id="usePolling" checked={field.value} onCheckedChange={field.onChange} disabled={p.disabled} />
          </Field>
        )}
      />
      {polling && <NumberField id="pollIntervalMs" label="Poll every (ms)" name="config.pollIntervalMs" {...p} />}
    </>
  );
}

const SEPARATORS = [
  { v: 'CR', label: 'CR (\\r) — HL7 standard' },
  { v: 'CRLF', label: 'CRLF (\\r\\n) — Windows' },
  { v: 'LF', label: 'LF (\\n)' },
] as const;

/** Outbound file channel: order folder, file name, separator. */
export function OutboundFileFields(p: FieldProps) {
  const fileName = useWatch({ control: p.control, name: 'config.fileName' });
  const sample = renderFileName(fileName || '', {
    messageType: 'ORM',
    trigger: 'O01',
    controlId: 'AW1A2B3C',
    timestamp: '20261111143005',
    date: '20261111',
    seq: '000001',
    id: '3f2a…',
  });
  return (
    <>
      <FolderField id="directory" label="Order folder" name="config.directory" help="Finished .hl7 files appear here for the LIS. Created when the channel starts." {...p} />
      <Field data-invalid={p.invalid('config.fileName')}>
        <FieldLabel htmlFor="fileName">File name</FieldLabel>
        <Input id="fileName" className="font-mono text-sm" disabled={p.disabled} aria-invalid={p.invalid('config.fileName')} {...p.register('config.fileName')} />
        <div className="flex flex-wrap gap-1.5">
          {FILE_NAME_PRESETS.map((preset) => (
            <Controller
              key={preset}
              control={p.control}
              name="config.fileName"
              render={({ field }) => (
                <button
                  type="button"
                  disabled={p.disabled}
                  onClick={() => field.onChange(preset)}
                  className={cn(
                    'rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
                    field.value === preset ? 'border-brand bg-brand/8' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {preset}
                </button>
              )}
            />
          ))}
        </div>
        <FieldDescription>
          Tokens: <span className="font-mono">{'{messageType} {trigger} {controlId} {timestamp} {date} {seq} {id}'}</span>. Example:{' '}
          <span className="font-mono text-foreground">{sample}</span>. An existing file is never overwritten.
        </FieldDescription>
        <FieldError errors={[p.err('config.fileName')]} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="segmentSeparator">Line ending</FieldLabel>
          <Controller
            control={p.control}
            name="config.segmentSeparator"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={p.disabled}>
                <SelectTrigger id="segmentSeparator" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEPARATORS.map((s) => (
                    <SelectItem key={s.v} value={s.v}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="encoding">Encoding</FieldLabel>
          <Controller
            control={p.control}
            name="config.encoding"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={p.disabled}>
                <SelectTrigger id="encoding" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="utf8">UTF-8</SelectItem>
                  <SelectItem value="latin1">Latin-1</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="onExists">If the name exists</FieldLabel>
          <Controller
            control={p.control}
            name="config.onExists"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={p.disabled}>
                <SelectTrigger id="onExists" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="suffix">Add _1, _2…</SelectItem>
                  <SelectItem value="fail">Fail the message</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </Field>
      </div>
    </>
  );
}
