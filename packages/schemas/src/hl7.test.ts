import { describe, expect, it } from 'vitest';
import {
  buildHl7,
  controlIdOf,
  fieldComponents,
  getField,
  hl7JsonSchema,
  messageTypeOf,
  parseHl7,
  unescapeHl7,
  versionOf,
} from './hl7';

const CR = '\r';

/** Realistic samples (as commonly produced by lab systems and HAPI TestPanel). */
const SAMPLES: Record<string, string> = {
  oru: [
    'MSH|^~\\&|LAB|HOSP|EMR|HOSP|20261111120000||ORU^R01^ORU_R01|MSG00001|P|2.5.1',
    'PID|1||123456^^^HOSP^MR||DOE^JANE^A||19800101|F|||1 MAIN ST^^TOWN^ST^12345||(555)555-1234~(555)555-9876',
    'PV1|1|O|CLINIC^ROOM1^BED1',
    'OBR|1|ORD123|FIL456|CBC^COMPLETE BLOOD COUNT^L|||20261111113000',
    'OBX|1|NM|WBC^WBC^L||5.5|10*3/uL|4.0-11.0|N|||F',
    'OBX|2|ST|NOTE^Comment||Pipe \\F\\ amp \\T\\ caret \\S\\ tilde \\R\\ backslash \\E\\ hex \\X0D\\||||||F',
  ].join(CR),
  adt: [
    'MSH|^~\\&|REG|HOSP||HOSP|20261111080000||ADT^A01|000001|P|2.3',
    'EVN|A01|20261111080000',
    'PID|||MRN001^^^HOSP^MR~SSN001^^^USA^SS||SMITH^JOHN^^JR^MR||19700707|M||2106-3|',
    'NK1|1|SMITH^JANE|SPO',
    'PV1||I|W^389^1^UABH^^^^3||||12345^MORGAN^REX^J^^^MD^0010^UAMC^L',
  ].join(CR),
  subcomponents: [
    'MSH|^~\\&|A|B|C|D|20260101||ORM^O01|CTRL|P|2.4',
    'ORC|NW|ORD1^EHR&2.16.840.1&ISO||',
    'OBR|1|||TEST^Name&alias&x^L|||||||||||||||||||||F',
  ].join(CR),
  trailingEmpties: 'MSH|^~\\&|A|B|||20260101||ACK|1|P|2.5||||' + CR + 'MSA|AA|1||' + CR + 'ZZZ',
  customDelimiters: 'MSH#*%?@#SND#FAC###20260101##ADT*A04#99#P#2.3' + CR + 'PID###ID1***MR##LAST*FIRST',
  minimal: 'MSH|^~\\&|',
};

describe('parseHl7 / buildHl7 round trip', () => {
  for (const [name, raw] of Object.entries(SAMPLES)) {
    it(`round-trips the ${name} sample byte for byte`, () => {
      const json = parseHl7(raw);
      expect(buildHl7(json)).toBe(raw);
      // Also survives JSON serialisation and schema validation.
      const again = hl7JsonSchema.parse(JSON.parse(JSON.stringify(json)));
      expect(buildHl7(again)).toBe(raw);
    });
  }

  it('normalises \\n and \\r\\n segment separators and drops the trailing one', () => {
    const raw = SAMPLES.oru!;
    expect(buildHl7(parseHl7(raw.replace(/\r/g, '\n') + '\n'))).toBe(raw);
    expect(buildHl7(parseHl7(raw.replace(/\r/g, '\r\n') + '\r\n'))).toBe(raw);
    expect(buildHl7(parseHl7(raw + CR))).toBe(raw);
  });

  it('produces the documented shape', () => {
    const json = parseHl7(SAMPLES.oru!);
    expect(json.delimiters).toEqual({ field: '|', component: '^', repeat: '~', escape: '\\', subcomponent: '&' });
    const msh = json.segments[0]!;
    expect(msh.id).toBe('MSH');
    expect(msh.fields[0]).toBe('|');
    expect(msh.fields[1]).toBe('^~\\&');
    expect(msh.fields[8]).toEqual(['ORU', 'R01', 'ORU_R01']); // MSH-9
    const pid = json.segments[1]!;
    expect(pid.fields[2]).toEqual(['123456', '', '', 'HOSP', 'MR']); // PID-3
    expect(pid.fields[4]).toEqual(['DOE', 'JANE', 'A']); // PID-5
    expect(pid.fields[12]).toEqual({ repeat: ['(555)555-1234', '(555)555-9876'] }); // PID-13
    // Escapes are kept verbatim in leaves.
    expect(json.segments[5]!.fields[4]).toBe(
      'Pipe \\F\\ amp \\T\\ caret \\S\\ tilde \\R\\ backslash \\E\\ hex \\X0D\\',
    );
  });

  it('keeps subcomponents as nested arrays', () => {
    const json = parseHl7(SAMPLES.subcomponents!);
    expect(json.segments[1]!.fields[1]).toEqual(['ORD1', ['EHR', '2.16.840.1', 'ISO']]);
    expect(json.segments[2]!.fields[3]).toEqual(['TEST', ['Name', 'alias', 'x'], 'L']);
  });

  it('reads custom delimiters from MSH', () => {
    const json = parseHl7(SAMPLES.customDelimiters!);
    expect(json.delimiters).toEqual({ field: '#', component: '*', repeat: '%', escape: '?', subcomponent: '@' });
    expect(json.segments[1]!.fields[2]).toEqual(['ID1', '', '', 'MR']);
    expect(messageTypeOf(json)).toBe('ADT^A04');
  });

  it('exposes header helpers', () => {
    const json = parseHl7(SAMPLES.oru!);
    expect(messageTypeOf(json)).toBe('ORU^R01');
    expect(controlIdOf(json)).toBe('MSG00001');
    expect(versionOf(json)).toBe('2.5.1');
    expect(fieldComponents(getField(json, 'PID', 5))).toEqual(['DOE', 'JANE', 'A']);
    expect(fieldComponents(getField(json, 'PID', 13))).toEqual(['(555)555-1234']); // first repeat
    expect(messageTypeOf(parseHl7(SAMPLES.minimal!))).toBeNull();
    expect(controlIdOf(parseHl7(SAMPLES.minimal!))).toBeNull();
  });

  it('decodes escapes only on request', () => {
    const json = parseHl7(SAMPLES.oru!);
    expect(unescapeHl7(json.segments[5]!.fields[4] as string, json.delimiters)).toBe(
      'Pipe | amp & caret ^ tilde ~ backslash \\ hex \r',
    );
    expect(unescapeHl7('line\\.br\\break')).toBe('line\nbreak');
    expect(unescapeHl7('unknown \\Z9\\ stays')).toBe('unknown \\Z9\\ stays');
  });

  it('rejects malformed input with a readable error', () => {
    expect(() => parseHl7('')).toThrow(/Empty/);
    expect(() => parseHl7('PID|1')).toThrow(/MSH/);
    expect(() => parseHl7('MSH|^~\\&|A' + CR + 'bad|x')).toThrow(/invalid id "bad"/);
    expect(() => parseHl7('MSH|^^\\&|A')).toThrow(/Invalid delimiters/);
    expect(() => buildHl7({ segments: [{ id: 'PID', fields: [] }] })).toThrow(/First segment must be MSH/);
    expect(() => buildHl7({ segments: [{ id: 'MSH', fields: ['|', '^~\\&'] }, { id: 'pid', fields: [] }] })).toThrow();
    expect(() => buildHl7({ segments: [{ id: 'MSH', fields: ['#', '^~\\&'] }] })).toThrow(/MSH-1/);
  });

  it('builds from hand-written JSON with default delimiters', () => {
    const hl7 = buildHl7({
      segments: [
        { id: 'MSH', fields: ['|', '^~\\&', 'APP', 'FAC', '', '', '20260101', '', ['ADT', 'A01'], '1', 'P', '2.5'] },
        { id: 'PID', fields: ['1', '', 'MRN', '', ['DOE', 'JANE'], '', '', '', '', '', '', '', { repeat: ['a', ['b', 'c']] }] },
      ],
    });
    expect(hl7).toBe('MSH|^~\\&|APP|FAC|||20260101||ADT^A01|1|P|2.5' + CR + 'PID|1||MRN||DOE^JANE||||||||a~b^c');
  });
});
