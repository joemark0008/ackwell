import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHl7, controlIdOf, messageTypeOf, parseHl7, readDelimiters, versionOf, type Hl7Delimiters } from './hl7';
import { flatToHl7, fromFlat, isHl7FlatVersion, toFlat } from './hl7-flat';

/**
 * Round-trips every wire fixture in `fixtures/hl7/` (see its README): HL7 → lossless JSON → HL7 must be
 * byte for byte, and for the versions with a typed flat format HL7 → flat → HL7 must match apart from
 * trailing empty fields / components / subcomponents (documented in docs/HL7-TYPED-JSON.md).
 */
const DIR = new URL('../../../fixtures/hl7/', import.meta.url);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.hl7'))
  .sort();
const load = (f: string) => readFileSync(new URL(f, DIR), 'utf8');

/** Expected header facts per fixture (guards against an accidentally edited / LF-converted file). */
const EXPECTED: Record<string, { type: string; control: string; version: string }> = {
  'adt_a01_v2.3.hl7': { type: 'ADT^A01', control: 'ADT20261116001', version: '2.3' },
  'adt_a08_zseg_custom_delims_v2.5.1.hl7': { type: 'ADT^A08', control: 'ZSEG000777', version: '2.5.1' },
  'orm_o01_v2.4.hl7': { type: 'ORM^O01', control: 'ORM0001934', version: '2.4' },
  'oru_r01_v2.5.1.hl7': { type: 'ORU^R01', control: 'LAB20261116A7', version: '2.5.1' },
  'siu_s12_v2.3.hl7': { type: 'SIU^S12', control: 'SIU0004411', version: '2.3' },
};

/** Drops trailing empty subcomponents, components and fields of every segment (MSH-1/MSH-2 kept raw). */
function stripTrailingEmpties(raw: string, d: Hl7Delimiters): string {
  const trim = (parts: string[]) => {
    let end = parts.length;
    while (end > 0 && parts[end - 1] === '') end--;
    return parts.slice(0, end);
  };
  const field = (f: string) =>
    f
      .split(d.repeat)
      .map((rep) =>
        trim(rep.split(d.component).map((c) => trim(c.split(d.subcomponent)).join(d.subcomponent))).join(d.component),
      )
      .join(d.repeat);
  return raw
    .split('\r')
    .map((seg) => {
      const isMsh = seg.startsWith('MSH');
      const head = isMsh ? seg.slice(0, 8) : seg.slice(0, 3);
      const rest = isMsh ? seg.slice(9) : seg.slice(4);
      const fields = seg.length > head.length ? trim(rest.split(d.field).map(field)) : [];
      return fields.length ? head + d.field + fields.join(d.field) : head;
    })
    .join('\r');
}

describe('fixtures/hl7', () => {
  it('has the expected fixture set, stored with CR separators and no trailing CR', () => {
    expect(files).toEqual(Object.keys(EXPECTED).sort());
    for (const f of files) {
      const raw = load(f);
      expect(raw, f).not.toMatch(/\n/);
      expect(raw.endsWith('\r'), f).toBe(false);
      expect(raw.split('\r').length, f).toBeGreaterThanOrEqual(4);
    }
  });

  describe.each(files)('%s', (file) => {
    const raw = load(file);
    const exp = EXPECTED[file]!;

    it('lossless JSON round-trips byte for byte', () => {
      const json = parseHl7(raw);
      expect(buildHl7(json)).toBe(raw);
      // And via a JSON serialisation (what the DB / API carry).
      expect(buildHl7(JSON.parse(JSON.stringify(json)))).toBe(raw);
      expect(json.segments.length).toBe(raw.split('\r').length);
    });

    it('header accessors read MSH-9 / MSH-10 / MSH-12', () => {
      const json = parseHl7(raw);
      expect(messageTypeOf(json)).toBe(exp.type);
      expect(controlIdOf(json)).toBe(exp.control);
      expect(versionOf(json)).toBe(exp.version);
    });

    it.runIf(isHl7FlatVersion(exp.version))('typed flat JSON round-trips (modulo trailing empties)', () => {
      const d = readDelimiters(raw);
      const flat = toFlat(parseHl7(raw));
      expect(flat.msh_12).toBe(exp.version);
      const back = flatToHl7(JSON.parse(JSON.stringify(flat)));
      expect(stripTrailingEmpties(back, d)).toBe(stripTrailingEmpties(raw, d));
      // fromFlat is the canonical lossless form of the same text.
      expect(buildHl7(fromFlat(flat))).toBe(back);
      // Z-segments stay positional and are not reordered.
      const zs = (flat.segments ?? []).filter((s) => /^Z/.test((s as { segment: string }).segment));
      const rawZ = raw.split('\r').filter((s) => s.startsWith('Z')).map((s) => s.slice(0, 3));
      expect(zs.map((s) => (s as { segment: string }).segment)).toEqual(rawZ);
    });
  });

  it('keeps escape sequences untouched in the lossless leaves', () => {
    const oru = parseHl7(load('oru_r01_v2.5.1.hl7'));
    const obx = oru.segments.filter((s) => s.id === 'OBX');
    expect(obx[3]!.fields[4]).toBe('Fasting 12h \\F\\ tube A\\S\\B \\T\\ sub \\R\\ rep \\E\\ esc');
    expect(obx[4]!.fields[4]).toBe('Line one\\X0D\\Line two');
    // Trailing empty fields are kept positionally (OBX-12..14).
    expect(obx[4]!.fields.length).toBe(14);
  });

  it('parses repeats, subcomponents and custom delimiters', () => {
    const adt = parseHl7(load('adt_a01_v2.3.hl7'));
    const pid = adt.segments.find((s) => s.id === 'PID')!;
    expect(pid.fields[2]).toEqual({
      repeat: [
        ['MRN100234', '', '', 'GOODHEALTH', 'MR'],
        ['SSN555443333', '', '', 'SSA', 'SS'],
      ],
    });
    expect(pid.fields[12]).toEqual({ repeat: ['(555)555-2004', ['(555)555-2005', '', 'CP']] });

    const orm = parseHl7(load('orm_o01_v2.4.hl7'));
    expect(orm.segments.find((s) => s.id === 'PID')!.fields[2]).toEqual(['MRN100234', '', '', ['GOODHEALTH', '1.2.3.4.5', 'ISO'], 'MR']);

    const z = parseHl7(load('adt_a08_zseg_custom_delims_v2.5.1.hl7'));
    expect(z.delimiters).toEqual({ field: '#', component: '*', repeat: '+', escape: '!', subcomponent: '%' });
    expect(z.segments.map((s) => s.id)).toEqual(['MSH', 'EVN', 'PID', 'ZPD', 'ZIN', 'PV1']);
    expect(z.segments[4]!.fields[1]).toEqual([['SUPPLEMENTAL', 'PLAN'], 'X1']);
  });
});
