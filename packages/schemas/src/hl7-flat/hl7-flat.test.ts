import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildHl7, parseHl7, type Hl7Json } from '../hl7';
import {
  escapeHl7,
  flatToHl7,
  fromFlat,
  hl7FlatSchema,
  segmentOf,
  segmentsOf,
  toFlat,
  tryToFlat,
  validateFlat,
  type Hl7Flat,
  type Hl7Flat_2_7,
  type Hl7v2_7,
} from './index';

const CR = '\r';

const SAMPLES: Record<string, string> = {
  oru_2_5_1: [
    'MSH|^~\\&|LAB|HOSP|EMR|HOSP|20261111120000||ORU^R01^ORU_R01|MSG00001|P|2.5.1',
    'PID|1||123456^^^HOSP^MR||DOE^JANE^A||19800101|F|||1 MAIN ST^^TOWN^ST^12345||(555)555-1234~(555)555-9876',
    'PV1|1|O|CLINIC^ROOM1^BED1',
    'OBR|1|ORD123|FIL456|CBC^COMPLETE BLOOD COUNT^L|||20261111113000',
    'OBX|1|NM|WBC^WBC^L||5.5|10*3/uL|4.0-11.0|N|||F',
    'OBR|2|ORD124|FIL457|BMP^BASIC METABOLIC PANEL^L',
    'OBX|1|ST|NOTE^Comment||Pipe \\F\\ amp \\T\\ caret \\S\\||||||F',
    'OBX|2|CE|ABO^Blood group||A^A pos^L~B^B pos^L||||||F',
  ].join(CR),
  adt_2_3: [
    'MSH|^~\\&|REG|HOSP||HOSP|20261111080000||ADT^A01|000001|P|2.3',
    'EVN|A01|20261111080000',
    'PID|||MRN001^^^HOSP^MR~SSN001^^^USA^SS||SMITH^JOHN^^JR^MR||19700707|M||2106-3',
    'NK1|1|SMITH^JANE|SPO',
    'PV1||I|W^389^1^UABH^^^^3||||12345^MORGAN^REX^J^^^MD^0010^UAMC^L',
  ].join(CR),
  adt_2_7: [
    'MSH|^~\\&|REG|HOSP|EMR|HOSP|20261111080000||ADT^A01^ADT_A01|000002|P|2.7^USA',
    'EVN||20261111080000',
    'PID|1||MRN001^^^HOSP&1.2.3&ISO^MR||SMITH^JOHN^Q||19700707|M',
    'ZPI|custom^value|x~y',
  ].join(CR),
};

/** Same message with trailing empty fields/components dropped (the only thing the flat form normalises). */
function normalise(raw: string): string {
  return flatToHl7(toFlat(parseHl7(raw)));
}

describe('toFlat', () => {
  it('flattens MSH to top-level keys with msh_12 as the version', () => {
    const flat = toFlat(parseHl7(SAMPLES.oru_2_5_1!));
    expect(flat).toMatchObject({
      msh_3_1: 'LAB',
      msh_9_1: 'ORU',
      msh_9_2: 'R01',
      msh_9_3: 'ORU_R01',
      msh_10: 'MSG00001',
      msh_11_1: 'P',
      msh_12: '2.5.1',
    });
    expect(flat).not.toHaveProperty('msh_1');
    expect(flat).not.toHaveProperty('delimiters');
  });

  it('keeps segment order, repeats as arrays, subcomponents as 3-part keys', () => {
    const flat = toFlat(parseHl7(SAMPLES.oru_2_5_1!));
    if (flat.msh_12 !== '2.5.1') throw new Error('expected 2.5.1');
    expect(flat.segments!.map((s) => s.segment)).toEqual(['PID', 'PV1', 'OBR', 'OBX', 'OBR', 'OBX', 'OBX']);
    const pid = segmentOf(flat, 'PID')!;
    expect(pid.pid_3).toEqual([{ pid_3_1: '123456', pid_3_4_1: 'HOSP', pid_3_5: 'MR' }]);
    expect(pid.pid_5).toEqual([{ pid_5_1_1: 'DOE', pid_5_2: 'JANE', pid_5_3: 'A' }]);
    expect(pid.pid_8).toBe('F');
    expect(pid.pid_13).toEqual([{ pid_13_1: '(555)555-1234' }, { pid_13_1: '(555)555-9876' }]);
  });

  it('keeps escapes and gives OBX-5 (varies) as raw repeats', () => {
    const obx = segmentsOf(toFlat(parseHl7(SAMPLES.oru_2_5_1!)), 'OBX');
    expect(obx[0]!.obx_5).toEqual(['5.5']);
    expect(obx[1]!.obx_5).toEqual(['Pipe \\F\\ amp \\T\\ caret \\S\\']);
    expect(obx[2]!.obx_5).toEqual(['A^A pos^L', 'B^B pos^L']);
  });

  it('uses each version’s own datatypes (2.3 TS, 2.7 HD subcomponents, VID)', () => {
    const v23 = toFlat(parseHl7(SAMPLES.adt_2_3!));
    expect(v23).toMatchObject({ msh_7_1: '20261111080000', msh_12: '2.3' });
    const v27 = toFlat(parseHl7(SAMPLES.adt_2_7!));
    expect(v27).toMatchObject({ msh_7: '20261111080000', msh_12: '2.7', msh_12_2_1: 'USA' });
    const pid = segmentOf(v27, 'PID')!;
    expect(pid.pid_3).toEqual([{ pid_3_1: 'MRN001', pid_3_4_1: 'HOSP', pid_3_4_2: '1.2.3', pid_3_4_3: 'ISO', pid_3_5: 'MR' }]);
  });

  it('keeps Z-segments positional', () => {
    const flat = toFlat(parseHl7(SAMPLES.adt_2_7!));
    expect(flat.segments!.at(-1)).toEqual({ segment: 'ZPI', fields: [['custom', 'value'], { repeat: ['x', 'y'] }] });
  });

  it('puts what does not fit the definition into _extra as raw text', () => {
    const raw = [
      'MSH|^~\\&|A|B|||20260101||ADT^A01|1|P|2.7',
      'EVN|A01', // EVN-1 is not repeating and a plain field: fine
      'PID|1||ID1||A^B^C^D^E^F^G^H^I^J^K^L^M^N^O^P^Q^R^S^T^U^V^W^X^Y^Z|||M~F' + '|'.repeat(40) + 'beyond',
    ].join(CR);
    const flat = toFlat(parseHl7(raw));
    const pid = segmentOf(flat, 'PID')!;
    expect(pid._extra).toMatchObject({
      pid_5: 'A^B^C^D^E^F^G^H^I^J^K^L^M^N^O^P^Q^R^S^T^U^V^W^X^Y^Z',
      pid_8: 'M~F',
    });
    expect(Object.values(pid._extra!)).toContain('beyond');
    expect(pid).not.toHaveProperty('pid_5');
    expect(flatToHl7(flat)).toBe(raw);
  });

  it('keeps custom delimiters', () => {
    const raw = 'MSH#*%?@#SND#FAC###20260101##ADT*A04#99#P#2.3' + CR + 'PID###ID1***MR##LAST*FIRST';
    const flat = toFlat(parseHl7(raw));
    expect(flat.delimiters).toEqual({ field: '#', component: '*', repeat: '%', escape: '?', subcomponent: '@' });
    expect(flatToHl7(flat)).toBe(raw);
  });

  it('refuses unsupported versions and undefined segments', () => {
    const v24 = parseHl7('MSH|^~\\&|A|B|||20260101||ACK|1|P|2.4');
    expect(() => toFlat(v24)).toThrow(/2\.4 has no typed flat format/);
    expect(tryToFlat(v24)).toBeNull();
    // SPM does not exist in 2.3
    expect(tryToFlat(parseHl7('MSH|^~\\&|A|B|||20260101||OML^O21|1|P|2.3\rSPM|1'))).toBeNull();
  });
});

describe('round trip HL7 → flat → HL7', () => {
  for (const [name, raw] of Object.entries(SAMPLES)) {
    it(`rebuilds the ${name} sample byte for byte`, () => {
      expect(normalise(raw)).toBe(raw);
      // through JSON text too
      expect(flatToHl7(JSON.parse(JSON.stringify(toFlat(parseHl7(raw)))))).toBe(raw);
    });
  }

  it('drops only trailing empty fields and components', () => {
    expect(normalise('MSH|^~\\&|A|B|||20260101||ACK^|1|P|2.5.1||||\rMSA|AA|1||')).toBe(
      'MSH|^~\\&|A|B|||20260101||ACK|1|P|2.5.1\rMSA|AA|1',
    );
  });

  it('fromFlat returns the canonical lossless JSON', () => {
    const json: Hl7Json = fromFlat(toFlat(parseHl7(SAMPLES.adt_2_7!)));
    expect(buildHl7(json)).toBe(SAMPLES.adt_2_7);
  });
});

describe('building from typed flat JSON', () => {
  it('builds HL7 from a typed 2.7 object', () => {
    const msg: Hl7Flat_2_7 = {
      msh_3_1: 'EMR',
      msh_7: '20261111120000',
      msh_9_1: 'ADT',
      msh_9_2: 'A01',
      msh_10: 'CTRL1',
      msh_11_1: 'P',
      msh_12: '2.7',
      segments: [
        { segment: 'EVN', evn_2: '20261111120000' },
        {
          segment: 'PID',
          pid_3: [{ pid_3_1: 'MRN1', pid_3_4_1: 'HOSP', pid_3_5: 'MR' }],
          pid_5: [{ pid_5_1_1: escapeHl7("O'Brien|x"), pid_5_2: 'Pat' }],
          pid_8_1: 'F',
        },
        { segment: 'ZXT', fields: ['a', ['b', 'c']] },
      ],
    };
    expect(flatToHl7(msg)).toBe(
      [
        'MSH|^~\\&|EMR||||20261111120000||ADT^A01|CTRL1|P|2.7',
        'EVN||20261111120000',
        "PID|||MRN1^^^HOSP^MR||O'Brien\\F\\x^Pat|||F",
        'ZXT|a|b^c',
      ].join(CR),
    );
  });
});

describe('validateFlat / hl7FlatSchema', () => {
  const base = { msh_9_1: 'ADT', msh_9_2: 'A01', msh_12: '2.7' };

  it('accepts a valid message', () => {
    expect(validateFlat({ ...base, segments: [{ segment: 'PID', pid_5: [{ pid_5_1_1: 'X' }] }] }).ok).toBe(true);
  });

  it('reports every problem with its path', () => {
    const r = validateFlat({
      ...base,
      msh_99: 'x',
      msh_9: 'ADT^A01',
      segments: [
        { segment: 'PID', pid_5_1_1: 'X', pid_3: { pid_3_1: 'a' }, pid_8_1: 'F|M' },
        { segment: 'XYZ' },
        { segment: 'ZPI', fields: 'nope' },
        { segment: 'OBX', obx_5: ['ok', 7], _extra: { obx_5: 'dup', foo: 'x' } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const byPath = Object.fromEntries(r.issues.map((i) => [i.path.join('.'), i.message]));
    expect(Object.keys(byPath).sort()).toEqual(
      [
        'msh_99',
        'msh_9',
        'segments.0.pid_5_1_1',
        'segments.0.pid_3',
        'segments.0.pid_8_1',
        'segments.1.segment',
        'segments.2.fields',
        'segments.3.obx_5.1',
        'segments.3._extra.foo',
        'segments.3._extra.obx_5',
      ].sort(),
    );
    expect(byPath['segments.0.pid_8_1']).toMatch(/escape it with escapeHl7/);
  });

  it('rejects unknown versions', () => {
    const r = validateFlat({ msh_12: '2.4' });
    expect(r.ok).toBe(false);
  });

  it('works as a zod schema with issue paths', () => {
    const r = hl7FlatSchema.safeParse({ ...base, segments: [{ segment: 'PID', pid_99: 'x' }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['segments', 0, 'pid_99']);
  });
});

describe('types', () => {
  it('narrows by msh_12 and segment', () => {
    const msg = toFlat(parseHl7(SAMPLES.adt_2_7!)) as Hl7Flat;
    if (msg.msh_12 === '2.7') {
      expectTypeOf(msg).toEqualTypeOf<Hl7Flat_2_7>();
      for (const s of msg.segments ?? []) {
        if (s.segment === 'PID') {
          expectTypeOf(s).toEqualTypeOf<Hl7v2_7.PID>();
          expectTypeOf(s.pid_3).toEqualTypeOf<Hl7v2_7.PID['pid_3']>();
        }
      }
      expectTypeOf(segmentsOf(msg, 'OBX')).toEqualTypeOf<Hl7v2_7.OBX[]>();
    }
  });

  it('rejects typos and wrong shapes at compile time', () => {
    const ok: Hl7Flat_2_7 = { msh_12: '2.7', msh_9_1: 'ADT' };
    // @ts-expect-error: unknown key
    const typo: Hl7Flat_2_7 = { msh_12: '2.7', msh_9_9: 'ADT' };
    // @ts-expect-error: msh_12 must match the version
    const wrongVersion: Hl7Flat_2_7 = { msh_12: '2.5.1' };
    // @ts-expect-error: PID-5 repeats, so it is an array
    const notArray: Hl7v2_7.PID = { segment: 'PID', pid_5: { pid_5_2: 'x' } };
    // @ts-expect-error: 2.3 MSH-7 is TS (msh_7_1), not a primitive
    const v23: Hl7Flat = { msh_12: '2.3', msh_7: '2026' };
    expect([ok, typo, wrongVersion, notArray, v23]).toHaveLength(5);
  });
});
