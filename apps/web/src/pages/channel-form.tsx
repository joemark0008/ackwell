import {
  HL7_VERSIONS,
  type Channel,
  type ChannelDirection,
  type ChannelTransport,
  type NewWebhookSecret,
  type UpdateChannel,
} from '@ackwell/schemas';
import { ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Loader2, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { WebhookSecretDialog } from '@/components/webhook-secret-dialog';
import { InboundFileFields, OutboundFileFields, TransportPicker } from '@/components/file-fields';
import { fileInboundFlow, fileOutboundFlow, Flow, inboundFlow, outboundFlow } from '@/components/flow';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  channelResolver,
  emptyForm,
  formFromChannel,
  nextFreePort,
  serverErrors,
  toPayload,
  type ChannelFormValues,
} from '@/lib/channel-form';
import { useChannel, useChannels, useCreateChannel, useSettings, useUpdateChannel } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function NewChannelPage() {
  const [params] = useSearchParams();
  const direction: ChannelDirection = params.get('direction') === 'outbound' ? 'outbound' : 'inbound';
  const transport: ChannelTransport = params.get('transport') === 'file' ? 'file' : 'mllp';
  return <ChannelForm key={`${direction}-${transport}`} direction={direction} transport={transport} />;
}

export function EditChannelPage() {
  const { id = '' } = useParams();
  const { data, isPending, isError } = useChannel(id);
  if (isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (isError || !data) return <p className="text-sm text-destructive">Channel not found.</p>;
  return <ChannelForm key={data.id} direction={data.direction} transport={data.transport} channel={data} />;
}

function DirectionPicker({ value, transport }: { value: ChannelDirection; transport: ChannelTransport }) {
  const opts = [
    { v: 'inbound' as const, icon: ArrowDownToLine, title: 'Inbound', body: 'Listen for HL7, deliver JSON', tone: 'inbound' },
    { v: 'outbound' as const, icon: ArrowUpFromLine, title: 'Outbound', body: 'Accept JSON, send HL7', tone: 'outbound' },
  ];
  return (
    <div role="radiogroup" aria-label="Direction" className="grid gap-3 sm:grid-cols-2">
      {opts.map(({ v, icon: Icon, title, body, tone }) => {
        const active = v === value;
        return (
          <Link
            key={v}
            to={`/channels/new?direction=${v}${transport === 'file' ? '&transport=file' : ''}`}
            replace
            role="radio"
            aria-checked={active}
            className={cn(
              'flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              active ? (tone === 'inbound' ? 'border-inbound ring-1 ring-inbound' : 'border-outbound ring-1 ring-outbound') : 'hover:bg-muted/40',
            )}
          >
            <Icon className={cn('mt-0.5 size-4', tone === 'inbound' ? 'text-inbound' : 'text-outbound')} />
            <span>
              <span className="block text-sm font-medium">{title}</span>
              <span className="block text-xs text-muted-foreground">{body}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <FieldGroup>{children}</FieldGroup>
      </CardContent>
    </Card>
  );
}

function ChannelForm({
  direction,
  transport,
  channel,
}: {
  direction: ChannelDirection;
  transport: ChannelTransport;
  channel?: Channel;
}) {
  const navigate = useNavigate();
  const settings = useSettings();
  const channels = useChannels();
  const create = useCreateChannel();
  const update = useUpdateChannel(channel?.id ?? '');
  const isEdit = Boolean(channel);
  const running = channel?.status === 'running';
  const [newSecret, setNewSecret] = useState<{ channelId: string; secret: NewWebhookSecret } | null>(null);
  const range = settings.data?.mllp.portRange;

  const suggested = useMemo(
    () => (range && channels.data ? nextFreePort(range, channels.data, channel?.id) : undefined),
    [range, channels.data, channel?.id],
  );

  const form = useForm<ChannelFormValues>({
    resolver: channelResolver,
    mode: 'onTouched',
    defaultValues: channel ? formFromChannel(channel) : emptyForm(direction, undefined, transport),
  });
  const { register, control, handleSubmit, watch, setError, setValue, getValues, formState } = form;
  const { errors, isSubmitting } = formState;

  // Pre-fill the next free inbound port once settings + channels are loaded.
  useEffect(() => {
    if (!isEdit && direction === 'inbound' && transport === 'mllp' && suggested && !getValues('config.port')) {
      setValue('config.port', String(suggested));
    }
  }, [isEdit, direction, transport, suggested, getValues, setValue]);

  const v = watch();
  const host = settings.data?.mllp.host ?? 'server';
  const preview =
    transport === 'file'
      ? direction === 'inbound'
        ? fileInboundFlow(v.config.directory || '…', v.config.processedDirectory || '…', v.config.errorDirectory || '…', v.delivery.url)
        : fileOutboundFlow(v.config.directory || '…', v.config.fileName || '…')
      : direction === 'inbound'
        ? inboundFlow(`${host}:${v.config.port || '…'}`, v.delivery.url)
        : outboundFlow(`${v.config.host || 'host'}:${v.config.port || '…'}`);

  async function onSubmit(values: ChannelFormValues) {
    const payload = toPayload(values);
    try {
      if (isEdit) {
        const saved = await update.mutateAsync(patchFrom(payload, channel!));
        toast.success('Channel saved');
        navigate(`/channels/${saved.id}`);
        return;
      }
      const created = await create.mutateAsync(payload);
      toast.success(`Created “${created.name}”`);
      if (created.webhookSecret) {
        // Shown once: the user must copy it before leaving.
        setNewSecret({ channelId: created.id, secret: created.webhookSecret });
        return;
      }
      navigate(`/channels/${created.id}`);
    } catch (e) {
      const { fields, form: formMsg } = serverErrors(e);
      for (const [name, message] of Object.entries(fields)) {
        setError(name as FieldPath<ChannelFormValues>, { type: 'server', message });
      }
      if (formMsg) setError('root.server', { type: 'server', message: formMsg });
    }
  }

  const err = (name: string) => {
    const parts = name.split('.');
    let cur: unknown = errors;
    for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
    return cur as { message?: string } | undefined;
  };
  const invalid = (name: string) => (err(name) ? true : undefined);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link
            to={channel ? `/channels/${channel.id}` : '/channels'}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> {channel ? channel.name : 'Channels'}
          </Link>
        }
        title={isEdit ? 'Edit channel' : `New ${direction} channel`}
        description={
          transport === 'file'
            ? direction === 'inbound'
              ? 'Watches a shared folder. Each finished .hl7 file is stored, delivered to your webhook as JSON and moved to the processed folder.'
              : 'Gives you a REST endpoint. JSON you POST is converted to HL7 and written as a finished .hl7 file into a shared folder.'
            : direction === 'inbound'
              ? 'Opens an MLLP port on the LAN. Messages are stored, acknowledged and delivered to your webhook as JSON.'
              : 'Gives you a REST endpoint. JSON you POST is converted to HL7 and sent to the target over MLLP.'
        }
      />

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-6">
          {!isEdit && <DirectionPicker value={direction} transport={transport} />}
          {!isEdit && <TransportPicker direction={direction} value={transport} filesEnabled={settings.data?.files.enabled ?? false} />}

          {running && (
            <p className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
              <Lock className="size-4 text-muted-foreground" />
              This channel is running. Stop it to change connection, delivery or HL7 version.
            </p>
          )}

          <Section title="General">
            <Field data-invalid={invalid('name')}>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" placeholder={direction === 'inbound' ? 'Lab results in' : 'Orders to LIS'} aria-invalid={invalid('name')} {...register('name')} />
              <FieldError errors={[err('name')]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={invalid('hl7Version')}>
                <FieldLabel htmlFor="hl7Version">HL7 version</FieldLabel>
                <Controller
                  control={control}
                  name="hl7Version"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={running}>
                      <SelectTrigger id="hl7Version" className="w-full font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HL7_VERSIONS.map((ver) => (
                          <SelectItem key={ver} value={ver} className="font-mono">
                            {ver}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[err('hl7Version')]} />
              </Field>
              <Field data-invalid={invalid('retentionDays')}>
                <FieldLabel htmlFor="retentionDays">Keep messages for (days)</FieldLabel>
                <Input
                  id="retentionDays"
                  inputMode="numeric"
                  placeholder={`Default (${settings.data?.retentionDefaultDays ?? 7})`}
                  aria-invalid={invalid('retentionDays')}
                  {...register('retentionDays')}
                />
                <FieldError errors={[err('retentionDays')]} />
              </Field>
            </div>
          </Section>

          {transport === 'file' ? (
            <>
              <Section
                title={direction === 'inbound' ? 'Folders' : 'Order file'}
                description={
                  direction === 'inbound'
                    ? 'Folders inside the shared root mounted on the server. Only finished files are read.'
                    : 'Each message becomes one finished file: written aside first, then moved into the folder in one step.'
                }
              >
                {direction === 'inbound' ? (
                  <InboundFileFields control={control} register={register} err={err} invalid={invalid} disabled={running} />
                ) : (
                  <OutboundFileFields control={control} register={register} err={err} invalid={invalid} disabled={running} />
                )}
              </Section>
              {direction === 'inbound' ? (
                <DeliverySection register={register} control={control} err={err} invalid={invalid} disabled={running} />
              ) : (
                <RetrySection
                  register={register}
                  err={err}
                  invalid={invalid}
                  disabled={running}
                  description="Used when the folder is not reachable or not writable. Messages stay in order."
                />
              )}
            </>
          ) : direction === 'inbound' ? (
            <>
              <Section title="Listener" description="Where HL7 senders on your network connect.">
                <Field data-invalid={invalid('config.port')}>
                  <FieldLabel htmlFor="port">Listen port</FieldLabel>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-muted-foreground">{host}:</span>
                    <Input id="port" inputMode="numeric" className="w-28 font-mono" disabled={running} aria-invalid={invalid('config.port')} {...register('config.port')} />
                  </div>
                  <FieldDescription>
                    {range ? (
                      <>
                        Allowed range <span className="font-mono">{range.from}–{range.to}</span>
                        {suggested && <> · next free <span className="font-mono">{suggested}</span></>}
                      </>
                    ) : (
                      'Loading allowed range…'
                    )}
                  </FieldDescription>
                  <FieldError errors={[err('config.port')]} />
                </Field>
                <Field data-invalid={invalid('config.allowlistText')}>
                  <FieldLabel htmlFor="allowlist">Allowed source IPs</FieldLabel>
                  <Textarea
                    id="allowlist"
                    rows={3}
                    className="font-mono text-sm"
                    placeholder={'172.16.10.0/25\n10.0.0.15'}
                    disabled={running}
                    aria-invalid={invalid('config.allowlistText')}
                    {...register('config.allowlistText')}
                  />
                  <FieldDescription>One IP or CIDR per line. Leave empty to accept any host that can reach the port.</FieldDescription>
                  <FieldError errors={[err('config.allowlistText')]} />
                </Field>
                <TlsField control={control} disabled={running} direction="inbound" register={register} invalid={invalid} err={err} />
              </Section>

              <DeliverySection register={register} control={control} err={err} invalid={invalid} disabled={running} />
            </>
          ) : (
            <>
              <Section title="Target" description="The HL7 system Ackwell sends to over MLLP.">
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                  <Field data-invalid={invalid('config.host')}>
                    <FieldLabel htmlFor="host">Host</FieldLabel>
                    <Input id="host" placeholder="lis.hospital.local" className="font-mono text-sm" disabled={running} aria-invalid={invalid('config.host')} {...register('config.host')} />
                    <FieldError errors={[err('config.host')]} />
                  </Field>
                  <Field data-invalid={invalid('config.port')}>
                    <FieldLabel htmlFor="port">Port</FieldLabel>
                    <Input id="port" inputMode="numeric" className="font-mono" disabled={running} aria-invalid={invalid('config.port')} {...register('config.port')} />
                    <FieldError errors={[err('config.port')]} />
                  </Field>
                </div>
                <Field data-invalid={invalid('config.ackTimeoutMs')}>
                  <FieldLabel htmlFor="ackTimeoutMs">Wait for ACK (ms)</FieldLabel>
                  <Input id="ackTimeoutMs" inputMode="numeric" className="w-40 font-mono" disabled={running} aria-invalid={invalid('config.ackTimeoutMs')} {...register('config.ackTimeoutMs')} />
                  <FieldError errors={[err('config.ackTimeoutMs')]} />
                </Field>
                <TlsField control={control} disabled={running} direction="outbound" register={register} invalid={invalid} err={err} />
              </Section>

              <RetrySection register={register} err={err} invalid={invalid} disabled={running} />
            </>
          )}

          {errors.root?.server && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {errors.root.server.message}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 border-t pt-6">
            <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              {isEdit ? 'Save changes' : 'Create channel'}
            </Button>
          </div>
        </div>

        <aside className="lg:sticky lg:top-10 lg:self-start">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-sm">How it flows</CardTitle>
              <CardDescription>Updates as you type.</CardDescription>
            </CardHeader>
            <CardContent>
              <Flow steps={preview} />
            </CardContent>
          </Card>
        </aside>
      </form>
      <WebhookSecretDialog
        secret={newSecret?.secret ?? null}
        title="Your webhook signing secret"
        onClose={() => {
          const id = newSecret?.channelId;
          setNewSecret(null);
          if (id) navigate(`/channels/${id}`);
        }}
      />
    </div>
  );
}

type FormControl = ReturnType<typeof useForm<ChannelFormValues>>['control'];

function PemField({
  id,
  label,
  help,
  name,
  register,
  invalid,
  err,
  disabled,
  placeholder,
}: {
  id: string;
  label: string;
  help?: string;
  name: 'config.tlsCert' | 'config.tlsKey' | 'config.tlsCa';
  register: ReturnType<typeof useForm<ChannelFormValues>>['register'];
  invalid: (n: string) => boolean | undefined;
  err: (n: string) => { message?: string } | undefined;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Field data-invalid={invalid(name)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        rows={4}
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-xs"
        placeholder={placeholder ?? '-----BEGIN CERTIFICATE-----'}
        disabled={disabled}
        aria-invalid={invalid(name)}
        {...register(name)}
      />
      {help && <FieldDescription>{help}</FieldDescription>}
      <FieldError errors={[err(name)]} />
    </Field>
  );
}

function TlsField({
  control,
  disabled,
  direction,
  register,
  invalid,
  err,
}: {
  control: FormControl;
  disabled?: boolean;
  direction: ChannelDirection;
  register: ReturnType<typeof useForm<ChannelFormValues>>['register'];
  invalid: (n: string) => boolean | undefined;
  err: (n: string) => { message?: string } | undefined;
}) {
  const enabled = useWatch({ control, name: 'config.tlsEnabled' });
  const hasKey = useWatch({ control, name: 'config.tlsHasKey' });
  const pem = { register, invalid, err, disabled };
  return (
    <div className="space-y-3">
      <Controller
        control={control}
        name="config.tlsEnabled"
        render={({ field }) => (
          <Field orientation="horizontal" className="rounded-lg border p-3">
            <div className="flex-1 space-y-0.5">
              <FieldLabel htmlFor="tls">TLS</FieldLabel>
              <FieldDescription>
                {direction === 'inbound' ? 'Serve MLLP over TLS with your certificate.' : 'Connect to the target over TLS.'}
              </FieldDescription>
            </div>
            <Switch id="tls" checked={field.value} onCheckedChange={field.onChange} disabled={disabled} />
          </Field>
        )}
      />
      {enabled && direction === 'inbound' && (
        <div className="space-y-4 rounded-lg border border-dashed p-3">
          <PemField id="tlsCert" label="Certificate (PEM)" name="config.tlsCert" {...pem} />
          <PemField
            id="tlsKey"
            label="Private key (PEM)"
            name="config.tlsKey"
            placeholder={hasKey ? 'A key is stored. Leave empty to keep it.' : '-----BEGIN PRIVATE KEY-----'}
            help={hasKey ? 'A key is stored. Leave empty to keep it, or paste a new one to replace it.' : undefined}
            {...pem}
          />
          <PemField id="tlsCa" label="CA certificate (PEM, optional)" name="config.tlsCa" help="Needed to verify client certificates." {...pem} />
          <Controller
            control={control}
            name="config.tlsRequestCert"
            render={({ field }) => (
              <Field orientation="horizontal" data-invalid={invalid('config.tlsRequestCert')}>
                <div className="flex-1 space-y-0.5">
                  <FieldLabel htmlFor="requestCert">Require client certificate</FieldLabel>
                  <FieldDescription>Mutual TLS. Senders must present a certificate signed by the CA above.</FieldDescription>
                  <FieldError errors={[err('config.tlsRequestCert')]} />
                </div>
                <Switch id="requestCert" checked={field.value} onCheckedChange={field.onChange} disabled={disabled} />
              </Field>
            )}
          />
        </div>
      )}
      {enabled && direction === 'outbound' && (
        <div className="space-y-4 rounded-lg border border-dashed p-3">
          <PemField id="tlsCa" label="CA certificate (PEM, optional)" name="config.tlsCa" help="The CA that signed the target's certificate." {...pem} />
          <Controller
            control={control}
            name="config.tlsRejectUnauthorized"
            render={({ field }) => (
              <Field orientation="horizontal">
                <div className="flex-1 space-y-0.5">
                  <FieldLabel htmlFor="rejectUnauthorized">Verify the target certificate</FieldLabel>
                  <FieldDescription>Off accepts self-signed certificates.</FieldDescription>
                </div>
                <Switch id="rejectUnauthorized" checked={field.value} onCheckedChange={field.onChange} disabled={disabled} />
              </Field>
            )}
          />
        </div>
      )}
    </div>
  );
}

/** PATCH body: only send what may change; config/delivery replace as a whole. */
function patchFrom(payload: ReturnType<typeof toPayload>, ch: Channel): UpdateChannel {
  const p = payload as unknown as Record<string, unknown>;
  const patch: UpdateChannel = { name: p.name as string };
  if (p.retentionDays !== undefined) patch.retentionDays = p.retentionDays as number;
  if (ch.status !== 'running') {
    patch.hl7Version = p.hl7Version as UpdateChannel['hl7Version'];
    patch.config = p.config as Record<string, unknown>;
    if (ch.direction === 'inbound') patch.delivery = p.delivery as Record<string, unknown>;
  }
  return patch;
}

type Register = ReturnType<typeof useForm<ChannelFormValues>>['register'];
interface SectionFieldProps {
  register: Register;
  err: (n: string) => { message?: string } | undefined;
  invalid: (n: string) => boolean | undefined;
  disabled?: boolean;
}

const PAYLOAD_FORMATS = [
  { v: 'both', label: 'Typed + lossless', hint: 'Sends both `flat` (typed) and `json` (lossless).' },
  { v: 'typed', label: 'Typed only', hint: 'Sends `flat` (msh_9_1, pid_5 …). Falls back to `json` when the HL7 version has no typed definition (2.3, 2.5.1, 2.7 do).' },
  { v: 'lossless', label: 'Lossless only', hint: 'Sends `json` ({ segments: […] }), which keeps every field, repetition and Z-segment.' },
] as const;

function DeliverySection({ register, control, err, invalid, disabled }: SectionFieldProps & { control: ReturnType<typeof useForm<ChannelFormValues>>['control'] }) {
  const format = useWatch({ control, name: 'delivery.payload' });
  const running = disabled;
  return (
    <Section title="Delivery" description="Each parsed message is POSTed as JSON to this webhook, with retries.">
      <Field data-invalid={invalid('delivery.url')}>
        <FieldLabel htmlFor="webhook">Webhook URL</FieldLabel>
        <Input id="webhook" type="url" placeholder="https://ehr.local/hl7/inbound" className="font-mono text-sm" disabled={running} aria-invalid={invalid('delivery.url')} {...register('delivery.url')} />
        <FieldError errors={[err('delivery.url')]} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={invalid('delivery.timeoutMs')}>
          <FieldLabel htmlFor="timeoutMs">Timeout (ms)</FieldLabel>
          <Input id="timeoutMs" inputMode="numeric" className="font-mono" disabled={running} aria-invalid={invalid('delivery.timeoutMs')} {...register('delivery.timeoutMs')} />
          <FieldError errors={[err('delivery.timeoutMs')]} />
        </Field>
        <Field data-invalid={invalid('delivery.maxAttempts')}>
          <FieldLabel htmlFor="maxAttempts">Max attempts</FieldLabel>
          <Input id="maxAttempts" inputMode="numeric" className="font-mono" disabled={running} aria-invalid={invalid('delivery.maxAttempts')} {...register('delivery.maxAttempts')} />
          <FieldError errors={[err('delivery.maxAttempts')]} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="payloadFormat">JSON format</FieldLabel>
        <Controller
          control={control}
          name="delivery.payload"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange} disabled={running}>
              <SelectTrigger id="payloadFormat" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYLOAD_FORMATS.map((o) => (
                  <SelectItem key={o.v} value={o.v}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <FieldDescription>{PAYLOAD_FORMATS.find((o) => o.v === format)?.hint} The raw HL7 is always included as `raw`.</FieldDescription>
      </Field>
    </Section>
  );
}

function RetrySection({
  register,
  err,
  invalid,
  disabled,
  description = 'Used when the target is down or no ACK arrives. Messages stay in order.',
}: SectionFieldProps & { description?: string }) {
  const running = disabled;
  return (
    <Section title="Retries" description={description}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={invalid('config.retryMaxAttempts')}>
          <FieldLabel htmlFor="retryMax">Max attempts</FieldLabel>
          <Input id="retryMax" inputMode="numeric" className="font-mono" disabled={running} aria-invalid={invalid('config.retryMaxAttempts')} {...register('config.retryMaxAttempts')} />
          <FieldError errors={[err('config.retryMaxAttempts')]} />
        </Field>
        <Field data-invalid={invalid('config.retryBackoffSeconds')}>
          <FieldLabel htmlFor="retryBackoff">Backoff (seconds)</FieldLabel>
          <Input id="retryBackoff" inputMode="numeric" className="font-mono" disabled={running} aria-invalid={invalid('config.retryBackoffSeconds')} {...register('config.retryBackoffSeconds')} />
          <FieldError errors={[err('config.retryBackoffSeconds')]} />
        </Field>
      </div>
    </Section>
  );
}
