import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TypedJsonNote } from './typed-json-note';

describe('TypedJsonNote', () => {
  it('says typed JSON is available for a supported version', () => {
    render(<TypedJsonNote channel={{ hl7Version: '2.5.1', direction: 'inbound' }} />);
    expect(screen.getByText(/Available for HL7/)).toBeInTheDocument();
    expect(screen.getByText(/webhook "flat" field/)).toBeInTheDocument();
  });

  it('shows how to send it on outbound channels', () => {
    render(<TypedJsonNote channel={{ hl7Version: '2.7', direction: 'outbound' }} />);
    expect(screen.getByText(/"msh_12": "2.7"/)).toBeInTheDocument();
  });

  it('lists the supported versions when the channel version has none', () => {
    render(<TypedJsonNote channel={{ hl7Version: '2.4', direction: 'inbound' }} />);
    expect(screen.getByText(/Not available for HL7/)).toBeInTheDocument();
    expect(screen.getByText(/Typed JSON covers 2\.3, 2\.5\.1, 2\.7/)).toBeInTheDocument();
  });
});
