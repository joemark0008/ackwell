import { describe, expect, it } from 'vitest';
import {
  createChannelSchema,
  fileNamePatternSchema,
  inboundFileConfigSchema,
  isSafeRelativeFolder,
  matchesInclude,
  outboundFileConfigSchema,
  renderFileName,
} from './channel';

describe('file transport schemas', () => {
  it('defaults an omitted transport to mllp (existing channels and clients)', () => {
    const r = createChannelSchema.parse({ name: 'a', direction: 'outbound', config: { host: 'h', port: 1 } });
    expect(r.transport).toBe('mllp');
  });

  it('accepts file channels with defaults: ORDER / RESULT / PROCESSED / ERROR', () => {
    const out = createChannelSchema.parse({ name: 'o', direction: 'outbound', transport: 'file', config: {} });
    expect(out.config).toMatchObject({ directory: 'ORDER', fileName: '{messageType}_{controlId}.hl7', segmentSeparator: 'CR', onExists: 'suffix' });
    const inb = createChannelSchema.parse({
      name: 'i',
      direction: 'inbound',
      transport: 'file',
      config: {},
      delivery: { type: 'webhook', url: 'https://x.test/h' },
    });
    expect(inb.config).toMatchObject({ directory: 'RESULT', processedDirectory: 'PROCESSED', errorDirectory: 'ERROR', include: ['*.hl7'], stableMs: 2000, usePolling: true });
  });

  it('does not mix MLLP and file config', () => {
    expect(createChannelSchema.safeParse({ name: 'o', direction: 'outbound', transport: 'file', config: { host: 'h', port: 1 } }).success).toBe(false);
    expect(createChannelSchema.safeParse({ name: 'o', direction: 'outbound', transport: 'mllp', config: { directory: 'ORDER' } }).success).toBe(false);
  });

  it('keeps folders inside the shared root', () => {
    for (const ok of ['ORDER', 'lab/RESULT', 'Lab Results', 'a-b_c.(1)']) expect(isSafeRelativeFolder(ok)).toBe(true);
    for (const bad of ['/etc', '../x', 'a/../b', '.hidden', 'a//b', 'C:\\x', 'a\\b', 'a/']) expect(isSafeRelativeFolder(bad)).toBe(false);
  });

  it('requires three different inbound folders, none inside the watched one', () => {
    expect(inboundFileConfigSchema.safeParse({ processedDirectory: 'RESULT' }).success).toBe(false);
    expect(inboundFileConfigSchema.safeParse({ errorDirectory: 'RESULT/ERROR' }).success).toBe(false);
    expect(inboundFileConfigSchema.safeParse({ directory: 'in', processedDirectory: 'done', errorDirectory: 'bad' }).success).toBe(true);
  });

  it('validates file name patterns', () => {
    for (const ok of ['{messageType}_{controlId}.hl7', '{date}_{seq}.txt', 'ORDER-{id}.HL7']) expect(fileNamePatternSchema.safeParse(ok).success).toBe(true);
    expect(fileNamePatternSchema.safeParse('{nope}.hl7').error?.issues[0]?.message).toMatch(/Unknown token \{nope\}/);
    expect(fileNamePatternSchema.safeParse('a/{id}.hl7').success).toBe(false);
    expect(fileNamePatternSchema.safeParse('{id}').success).toBe(false); // no extension
    expect(fileNamePatternSchema.safeParse('.{id}.hl7').success).toBe(false); // hidden
    expect(outboundFileConfigSchema.safeParse({ segmentSeparator: 'CRLF' }).success).toBe(true);
  });

  it('renders file names safely', () => {
    expect(renderFileName('{messageType}_{trigger}_{controlId}.hl7', { messageType: 'ORM', trigger: 'O01', controlId: 'AB/12^3' })).toBe('ORM_O01_AB_12_3.hl7');
    expect(renderFileName('{controlId}.hl7', {})).toBe('NA.hl7');
    expect(renderFileName('{controlId}.hl7', { controlId: '..x' })).toBe('x.hl7');
  });

  it('matches include patterns case-insensitively', () => {
    expect(matchesInclude('R1.HL7', ['*.hl7'])).toBe(true);
    expect(matchesInclude('R1.hl7.part', ['*.hl7'])).toBe(false);
    expect(matchesInclude('a.txt', ['*.hl7', 'a.???'])).toBe(true);
  });
});
