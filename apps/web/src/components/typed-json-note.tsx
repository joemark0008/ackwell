import { HL7_FLAT_VERSIONS, isHl7FlatVersion, type Channel } from '@ackwell/schemas';

/**
 * Says whether the channel's HL7 version has the typed flat JSON (`msh_9_1`, `pid_5_1_1`, …).
 * The supported list comes from `HL7_FLAT_VERSIONS`, so new generated versions show up here by themselves.
 */
export function TypedJsonNote({ channel }: { channel: Pick<Channel, 'hl7Version' | 'direction'> }) {
  const supported = HL7_FLAT_VERSIONS.join(', ');
  if (isHl7FlatVersion(channel.hl7Version)) {
    return (
      <>
        Available for HL7 <span className="font-mono">{channel.hl7Version}</span>
        <span className="block text-xs text-muted-foreground">
          {channel.direction === 'inbound'
            ? 'Keys like msh_9_1 and pid_5_1_1 in the message viewer and in the webhook "flat" field.'
            : 'Send { "flat": { "msh_12": "' + channel.hl7Version + '", … } } and see the typed view in the message viewer.'}
        </span>
      </>
    );
  }
  return (
    <>
      Not available for HL7 <span className="font-mono">{channel.hl7Version}</span>
      <span className="block text-xs text-muted-foreground">
        Typed JSON covers {supported}. Messages of this version use the lossless JSON
        {channel.direction === 'inbound' ? ' (webhook "flat" is null)' : ''}. Each message's own MSH-12 decides, so a
        message stamped with a supported version still gets it.
      </span>
    </>
  );
}
