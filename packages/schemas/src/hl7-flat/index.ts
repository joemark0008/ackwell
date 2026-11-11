import { z } from 'zod';
import {
  DEFAULT_DELIMITERS,
  buildHl7,
  hl7DelimitersSchema,
  hl7FieldSchema,
  parseHl7,
  versionOf,
  type Hl7Component,
  type Hl7Delimiters,
  type Hl7Field,
  type Hl7FieldValue,
  type Hl7Json,
  type Hl7Segment,
} from '../hl7';
import type { Hl7FlatSpec, Hl7FlatZSegment } from './types';
import * as V2_3 from './generated/v2_3';
import * as V2_5_1 from './generated/v2_5_1';
import * as V2_7 from './generated/v2_7';

/**
 * Typed, flat HL7 v2 JSON ("flat format"), one TypeScript type per HL7 version.
 *
 *   {
 *     msh_3_1: 'LAB', msh_9_1: 'ADT', msh_9_2: 'A01', msh_11_1: 'P', msh_12: '2.7',
 *     segments: [
 *       { segment: 'PID', pid_3: [{ pid_3_1: '123', pid_3_4_1: 'HOSP', pid_3_5: 'MR' }], pid_5: [{ pid_5_1_1: 'DOE', pid_5_2: 'JANE' }] },
 *       { segment: 'OBX', obx_1: '1', obx_2: 'NM', obx_3_1: 'WBC', obx_5: ['5.5'] },
 *       { segment: 'ZPI', fields: ['a', ['b', 'c']] },
 *     ],
 *   }
 *
 * Rules
 * - Keys are `<segment>_<field>[_<component>[_<subcomponent>]]`, lower case, down to the leaves of the
 *   field's datatype in that version. A primitive field is `pid_8`; a composite one is `pid_5_2`, `pid_5_1_1`.
 * - The one exception is MSH-12: the version is always `msh_12` (also when MSH-12 is a VID composite), so
 *   it narrows `Hl7Flat` to `Hl7Flat_2_3 | Hl7Flat_2_5_1 | Hl7Flat_2_7`.
 * - MSH keys are at the top level. The other segments are in `segments`, in message order, each tagged with
 *   `segment: 'PID'` (the discriminant). Z-segments keep the positional `fields` of the lossless format.
 * - Repeating fields are arrays (of strings, or of objects with the same keys). Repeating segments simply
 *   appear several times in `segments`.
 * - Leaves are raw HL7 text, escape sequences kept (`\F\`, `\S\`, ...), the same as the lossless format.
 *   Use `escapeHl7` when you put free text into a leaf. A primitive field that arrives with components keeps
 *   them as raw text (`'a^b'`).
 * - Anything that does not fit the version's definition (an undefined field, too many components, repeats
 *   in a non-repeating field) goes to the segment's `_extra` as raw field text keyed `pid_40`, so no data is lost.
 * - Converting back trims trailing empty fields/components; otherwise the HL7 text is rebuilt as received.
 */

export type { Hl7FlatSpec, Hl7FlatZSegment, Prefixed } from './types';
export { V2_3 as Hl7v2_3, V2_5_1 as Hl7v2_5_1, V2_7 as Hl7v2_7 };

export type Hl7Flat_2_3 = V2_3.Message;
export type Hl7Flat_2_5_1 = V2_5_1.Message;
export type Hl7Flat_2_7 = V2_7.Message;
/** A typed flat message of any supported version; narrow it with `msg.msh_12 === '2.7'`. */
export type Hl7Flat = Hl7Flat_2_3 | Hl7Flat_2_5_1 | Hl7Flat_2_7;
/** Segment union (after MSH) of one version: `Hl7FlatSegment<'2.7'>`. */
export type Hl7FlatSegment<V extends Hl7FlatVersion = Hl7FlatVersion> = NonNullable<
  Extract<Hl7Flat, { msh_12: V }>['segments']
>[number];

export const HL7_FLAT_VERSIONS = ['2.3', '2.5.1', '2.7'] as const;
export type Hl7FlatVersion = (typeof HL7_FLAT_VERSIONS)[number];

const SPECS: Record<Hl7FlatVersion, Hl7FlatSpec> = {
  '2.3': V2_3.spec,
  '2.5.1': V2_5_1.spec,
  '2.7': V2_7.spec,
};

export function isHl7FlatVersion(v: unknown): v is Hl7FlatVersion {
  return typeof v === 'string' && (HL7_FLAT_VERSIONS as readonly string[]).includes(v);
}

export class Hl7FlatError extends Error {
  override name = 'Hl7FlatError';
}

const Z_SEGMENT = /^Z[A-Z0-9]{2}$/;

// ---- Field metadata ------------------------------------------------------------------------------

interface FieldInfo {
  /** Component datatypes when composite; per component, the subcomponent count (0 = leaf component). */
  components: number[] | null;
  repeating: boolean;
}

function fieldInfo(spec: Hl7FlatSpec, segment: string, n: number): FieldInfo | undefined {
  const raw = spec.segments[segment]?.[n - 1];
  if (raw === undefined) return undefined;
  const repeating = raw.endsWith('*');
  const dt = repeating ? raw.slice(0, -1) : raw;
  const comps = spec.composites[dt];
  return { repeating, components: comps ? comps.map((c) => spec.composites[c]?.length ?? 0) : null };
}

/** `pid_5`, `pid_5_1`, `pid_5_1_2`, with MSH-12.1 aliased to `msh_12`. */
function leafKey(segment: string, n: number, c?: number, s?: number): string {
  if (segment === 'MSH' && n === 12 && c === 1 && s === undefined) return 'msh_12';
  let k = `${segment.toLowerCase()}_${n}`;
  if (c !== undefined) k += `_${c}`;
  if (s !== undefined) k += `_${s}`;
  return k;
}

/** Every leaf key of a composite field, e.g. pid_5_1_1 … pid_5_14. */
function compositeKeys(segment: string, n: number, components: number[]): string[] {
  const keys: string[] = [];
  components.forEach((subs, j) => {
    if (!subs) keys.push(leafKey(segment, n, j + 1));
    else for (let k = 1; k <= subs; k++) keys.push(leafKey(segment, n, j + 1, k));
  });
  return keys;
}

// ---- Lossless → flat -----------------------------------------------------------------------------

function valueText(v: Hl7FieldValue, d: Hl7Delimiters): string {
  if (typeof v === 'string') return v;
  return v.map((c) => (Array.isArray(c) ? c.join(d.subcomponent) : c)).join(d.component);
}

function fieldText(f: Hl7Field, d: Hl7Delimiters): string {
  if (typeof f === 'object' && !Array.isArray(f)) return f.repeat.map((r) => valueText(r, d)).join(d.repeat);
  return valueText(f, d);
}

/** Flattens one repeat of a composite field, or returns null when it does not fit the definition. */
function flattenComposite(
  segment: string,
  n: number,
  components: number[],
  value: Hl7FieldValue,
  d: Hl7Delimiters,
): Record<string, string> | null {
  const comps: Hl7Component[] = typeof value === 'string' ? [value] : value;
  if (comps.length > components.length) return null;
  const out: Record<string, string> = {};
  for (let j = 0; j < comps.length; j++) {
    const c = comps[j]!;
    const subs = components[j]!;
    if (!subs) {
      const text = typeof c === 'string' ? c : c.join(d.subcomponent);
      if (text !== '') out[leafKey(segment, n, j + 1)] = text;
      continue;
    }
    const parts = typeof c === 'string' ? [c] : c;
    if (parts.length > subs) return null;
    parts.forEach((p, k) => {
      if (p !== '') out[leafKey(segment, n, j + 1, k + 1)] = p;
    });
  }
  return out;
}

function flattenSegment(seg: Hl7Segment, spec: Hl7FlatSpec, d: Hl7Delimiters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extra: Record<string, string> = {};
  const isMsh = seg.id === 'MSH';
  seg.fields.forEach((field, i) => {
    const n = i + 1;
    if (isMsh && n <= 2) return;
    if (field === '') return;
    const info = fieldInfo(spec, seg.id, n);
    const key = leafKey(seg.id, n);
    if (!info) {
      extra[key] = fieldText(field, d);
      return;
    }
    const repeats = typeof field === 'object' && !Array.isArray(field) ? field.repeat : [field];
    if (!info.repeating && repeats.length > 1) {
      extra[key] = fieldText(field, d);
      return;
    }
    if (!info.components) {
      const texts = repeats.map((r) => valueText(r, d));
      out[key] = info.repeating ? texts : texts[0];
      return;
    }
    const objs = repeats.map((r) => flattenComposite(seg.id, n, info.components!, r, d));
    if (objs.some((o) => o === null)) {
      extra[key] = fieldText(field, d);
      return;
    }
    if (info.repeating) out[key] = objs;
    else Object.assign(out, objs[0]);
  });
  if (Object.keys(extra).length) out._extra = extra;
  return out;
}

/**
 * Lossless JSON → typed flat JSON. Throws `Hl7FlatError` when MSH-12 is not a supported version
 * (`HL7_FLAT_VERSIONS`) or a non-Z segment is not defined in that version.
 */
export function toFlat(msg: Hl7Json): Hl7Flat {
  const version = versionOf(msg);
  if (!isHl7FlatVersion(version)) {
    throw new Hl7FlatError(
      `HL7 version ${version ?? '(none)'} has no typed flat format (supported: ${HL7_FLAT_VERSIONS.join(', ')})`,
    );
  }
  const spec = SPECS[version];
  const d = msg.delimiters;
  const [msh, ...rest] = msg.segments;
  if (!msh || msh.id !== 'MSH') throw new Hl7FlatError('First segment must be MSH');

  const top = flattenSegment(msh, spec, d);
  top.msh_12 = version; // MSH-12 may carry more components; the version itself is the discriminant
  const segments = rest.map((seg) => {
    if (Z_SEGMENT.test(seg.id)) return { segment: seg.id, fields: seg.fields };
    if (!spec.segments[seg.id] || seg.id === 'MSH') {
      throw new Hl7FlatError(`Segment ${seg.id} is not defined in HL7 ${version}`);
    }
    return { segment: seg.id, ...flattenSegment(seg, spec, d) };
  });
  const flat: Record<string, unknown> = { ...top };
  if (!sameDelimiters(d, DEFAULT_DELIMITERS)) flat.delimiters = d;
  if (segments.length) flat.segments = segments;
  return flat as unknown as Hl7Flat;
}

/** `toFlat`, or null when the message has no flat form (unsupported version or unknown segment). */
export function tryToFlat(msg: Hl7Json): Hl7Flat | null {
  try {
    return toFlat(msg);
  } catch (e) {
    if (e instanceof Hl7FlatError) return null;
    throw e;
  }
}

function sameDelimiters(a: Hl7Delimiters, b: Hl7Delimiters): boolean {
  return (
    a.field === b.field &&
    a.component === b.component &&
    a.repeat === b.repeat &&
    a.escape === b.escape &&
    a.subcomponent === b.subcomponent
  );
}

// ---- Flat → lossless -----------------------------------------------------------------------------

function trimEnd<T>(arr: T[], isEmpty: (v: T) => boolean): T[] {
  let end = arr.length;
  while (end > 0 && isEmpty(arr[end - 1]!)) end--;
  return arr.slice(0, end);
}

function buildComposite(
  segment: string,
  n: number,
  components: number[],
  obj: Record<string, unknown>,
): Hl7FieldValue {
  const comps: Hl7Component[] = components.map((subs, j) => {
    if (!subs) return (obj[leafKey(segment, n, j + 1)] as string | undefined) ?? '';
    const parts: string[] = [];
    for (let k = 1; k <= subs; k++) parts.push((obj[leafKey(segment, n, j + 1, k)] as string | undefined) ?? '');
    const trimmed = trimEnd(parts, (p) => p === '');
    return trimmed.length <= 1 ? trimmed[0] ?? '' : trimmed;
  });
  const trimmed = trimEnd(comps, (c) => c === '');
  if (trimmed.length === 0) return '';
  if (trimmed.length === 1 && typeof trimmed[0] === 'string') return trimmed[0];
  return trimmed;
}

function unflattenSegment(id: string, obj: Record<string, unknown>, spec: Hl7FlatSpec, d: Hl7Delimiters): Hl7Segment {
  const defs = spec.segments[id]!;
  const fields: Hl7Field[] = [];
  for (let n = 1; n <= defs.length; n++) {
    if (id === 'MSH' && n <= 2) {
      fields.push(n === 1 ? d.field : `${d.component}${d.repeat}${d.escape}${d.subcomponent}`);
      continue;
    }
    const info = fieldInfo(spec, id, n)!;
    const key = leafKey(id, n);
    let field: Hl7Field = '';
    if (info.repeating) {
      const arr = obj[key] as unknown[] | undefined;
      if (arr?.length) {
        const values = arr.map((v) =>
          info.components ? buildComposite(id, n, info.components, v as Record<string, unknown>) : (v as string),
        );
        field = values.length === 1 ? values[0]! : { repeat: values };
      }
    } else if (info.components) {
      field = buildComposite(id, n, info.components, obj);
    } else {
      field = (obj[key] as string | undefined) ?? '';
    }
    fields.push(field);
  }
  const extra = (obj._extra ?? {}) as Record<string, string>;
  for (const [k, raw] of Object.entries(extra)) {
    const n = Number(k.slice(id.length + 1));
    while (fields.length < n) fields.push('');
    fields[n - 1] = raw; // raw text; the rebuild + reparse in fromFlat splits it again
  }
  return { id, fields: trimEnd(fields, (f) => f === '') };
}

/** Typed flat JSON → HL7 text. Validates first; throws `Hl7FlatError` listing every problem. */
export function flatToHl7(input: unknown): string {
  const flat = assertFlat(input);
  const spec = SPECS[flat.msh_12];
  const d = flat.delimiters ?? DEFAULT_DELIMITERS;
  const top = flat as unknown as Record<string, unknown>;
  const segments: Hl7Segment[] = [unflattenSegment('MSH', top, spec, d)];
  for (const seg of (flat.segments ?? []) as Array<Record<string, unknown> & { segment: string }>) {
    if (Z_SEGMENT.test(seg.segment)) segments.push({ id: seg.segment, fields: (seg as unknown as Hl7FlatZSegment).fields });
    else segments.push(unflattenSegment(seg.segment, seg, spec, d));
  }
  return buildHl7({ delimiters: d, segments });
}

/** Typed flat JSON → lossless JSON (canonical: identical to parsing the rebuilt HL7 text). */
export function fromFlat(input: unknown): Hl7Json {
  return parseHl7(flatToHl7(input));
}

// ---- Validation ----------------------------------------------------------------------------------

export interface Hl7FlatIssue {
  path: (string | number)[];
  message: string;
}

type KeyKind = { kind: 'leaf' } | { kind: 'leafArray' } | { kind: 'objArray'; keys: Set<string> };

const keyTables = new Map<string, Map<string, KeyKind>>();

/** Allowed keys of one segment object (for MSH: the top-level keys) in one version. */
function keyTable(spec: Hl7FlatSpec, segment: string): Map<string, KeyKind> {
  const cacheKey = `${spec.version}/${segment}`;
  const cached = keyTables.get(cacheKey);
  if (cached) return cached;
  const table = new Map<string, KeyKind>();
  spec.segments[segment]!.forEach((_, i) => {
    const n = i + 1;
    if (segment === 'MSH' && n <= 2) return;
    const info = fieldInfo(spec, segment, n)!;
    if (!info.components) table.set(leafKey(segment, n), { kind: info.repeating ? 'leafArray' : 'leaf' });
    else if (info.repeating) table.set(leafKey(segment, n), { kind: 'objArray', keys: new Set(compositeKeys(segment, n, info.components)) });
    else for (const k of compositeKeys(segment, n, info.components)) table.set(k, { kind: 'leaf' });
  });
  keyTables.set(cacheKey, table);
  return table;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a value against the flat format of the version in its `msh_12`: known keys only, the right
 * shapes (string / string[] / object[]), and no leaf containing a segment break, the field separator or
 * the repeat separator. Returns every problem with its path.
 */
export function validateFlat(input: unknown): { ok: true; value: Hl7Flat } | { ok: false; issues: Hl7FlatIssue[] } {
  const issues: Hl7FlatIssue[] = [];
  const add = (path: (string | number)[], message: string) => issues.push({ path, message });

  if (!isPlainObject(input)) return { ok: false, issues: [{ path: [], message: 'Expected an object' }] };
  const version = input.msh_12;
  if (!isHl7FlatVersion(version)) {
    add(['msh_12'], `msh_12 must be one of ${HL7_FLAT_VERSIONS.join(', ')}`);
    return { ok: false, issues };
  }
  const spec = SPECS[version];

  let d = DEFAULT_DELIMITERS;
  if (input.delimiters !== undefined) {
    const parsed = hl7DelimitersSchema.safeParse(input.delimiters);
    if (!parsed.success) add(['delimiters'], 'delimiters must be five distinct single characters');
    else d = parsed.data;
  }
  const forbidden = ['\r', '\n', d.field, d.repeat];
  const checkLeaf = (v: unknown, path: (string | number)[], allowRepeat = false) => {
    if (typeof v !== 'string') return add(path, 'Expected a string');
    const bad = forbidden.find((ch, i) => !(allowRepeat && i === 3) && v.includes(ch));
    if (bad !== undefined) add(path, `Must not contain ${JSON.stringify(bad)} (escape it with escapeHl7)`);
  };

  const checkSegment = (obj: Record<string, unknown>, segment: string, base: (string | number)[], skip: Set<string>) => {
    const table = keyTable(spec, segment);
    const fieldCount = spec.segments[segment]!.length;
    const usedFields = new Set<number>();
    for (const [k, v] of Object.entries(obj)) {
      if (skip.has(k)) continue;
      const path = [...base, k];
      if (k === '_extra') {
        if (!isPlainObject(v)) {
          add(path, 'Expected an object of raw field text');
          continue;
        }
        for (const [ek, ev] of Object.entries(v)) {
          const m = new RegExp(`^${segment.toLowerCase()}_(\\d+)$`).exec(ek);
          if (!m || Number(m[1]) < 1 || (segment === 'MSH' && Number(m[1]) <= 2)) {
            add([...path, ek], `Expected a field key like ${segment.toLowerCase()}_${fieldCount + 1}`);
            continue;
          }
          checkLeaf(ev, [...path, ek], true);
        }
        continue;
      }
      const kind = table.get(k);
      if (!kind) {
        add(path, `Unknown key for ${segment} in HL7 ${version}`);
        continue;
      }
      usedFields.add(Number(k.split('_')[1]));
      if (kind.kind === 'leaf') checkLeaf(v, path);
      else if (!Array.isArray(v)) add(path, `Expected an array (${k} repeats)`);
      else if (kind.kind === 'leafArray') v.forEach((item, i) => checkLeaf(item, [...path, i]));
      else
        v.forEach((item, i) => {
          if (!isPlainObject(item)) return add([...path, i], 'Expected an object');
          for (const [ik, iv] of Object.entries(item)) {
            if (!kind.keys.has(ik)) add([...path, i, ik], `Unknown key inside ${k} in HL7 ${version}`);
            else checkLeaf(iv, [...path, i, ik]);
          }
        });
    }
    if (isPlainObject(obj._extra)) {
      for (const ek of Object.keys(obj._extra)) {
        const n = Number(ek.split('_')[1]);
        if (usedFields.has(n)) add([...base, '_extra', ek], `Field ${segment}-${n} is set both as typed keys and in _extra`);
      }
    }
  };

  checkSegment(input, 'MSH', [], new Set(['msh_12', 'delimiters', 'segments']));

  if (input.segments !== undefined) {
    if (!Array.isArray(input.segments)) add(['segments'], 'Expected an array of segments');
    else
      input.segments.forEach((seg: unknown, i: number) => {
        const path = ['segments', i];
        if (!isPlainObject(seg) || typeof seg.segment !== 'string') {
          return add(path, 'Expected an object with a `segment` id, e.g. { segment: "PID", ... }');
        }
        const id = seg.segment;
        if (Z_SEGMENT.test(id)) {
          const extraKeys = Object.keys(seg).filter((k) => k !== 'segment' && k !== 'fields');
          if (extraKeys.length) add([...path, extraKeys[0]!], 'A Z-segment has only `segment` and `fields`');
          const fields = z.array(hl7FieldSchema).safeParse(seg.fields);
          if (!fields.success) add([...path, 'fields'], 'Expected positional fields, as in the lossless format');
          return;
        }
        if (id === 'MSH' || !spec.segments[id]) {
          return add([...path, 'segment'], `Segment ${id} is not defined in HL7 ${version} (Z-segments use { segment, fields })`);
        }
        checkSegment(seg, id, path, new Set(['segment']));
      });
  }

  return issues.length ? { ok: false, issues } : { ok: true, value: input as unknown as Hl7Flat };
}

function formatIssues(issues: Hl7FlatIssue[]): string {
  return issues
    .map((i) => `${i.path.length ? i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').slice(1) : '(root)'}: ${i.message}`)
    .join('; ');
}

/** `validateFlat`, throwing `Hl7FlatError` with every issue. */
export function assertFlat(input: unknown): Hl7Flat {
  const r = validateFlat(input);
  if (!r.ok) throw new Hl7FlatError(formatIssues(r.issues));
  return r.value;
}

/** Zod schema for the flat format (any supported version), reporting each issue at its own path. */
export const hl7FlatSchema = z.custom<Hl7Flat>().superRefine((value, ctx) => {
  const r = validateFlat(value);
  if (!r.ok) for (const issue of r.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
});

// ---- Helpers -------------------------------------------------------------------------------------

/** Escapes delimiters in free text before it goes into a leaf (`a|b` → `a\F\b`). */
export function escapeHl7(value: string, d: Hl7Delimiters = DEFAULT_DELIMITERS): string {
  const e = d.escape;
  let out = '';
  for (const ch of value.replace(/\r\n?/g, '\n')) {
    if (ch === e) out += `${e}E${e}`;
    else if (ch === d.field) out += `${e}F${e}`;
    else if (ch === d.component) out += `${e}S${e}`;
    else if (ch === d.subcomponent) out += `${e}T${e}`;
    else if (ch === d.repeat) out += `${e}R${e}`;
    else if (ch === '\n') out += `${e}.br${e}`;
    else out += ch;
  }
  return out;
}

/** All segments of one id, typed: `segmentsOf(msg, 'OBX')` → `OBX[]` of that message's version. */
export function segmentsOf<M extends Hl7Flat, Id extends string>(
  msg: M,
  id: Id,
): Extract<NonNullable<M['segments']>[number], { segment: Id }>[] {
  return ((msg.segments ?? []) as Array<{ segment: string }>).filter((s) => s.segment === id) as never;
}

/** First segment of one id, typed, or undefined. */
export function segmentOf<M extends Hl7Flat, Id extends string>(
  msg: M,
  id: Id,
): Extract<NonNullable<M['segments']>[number], { segment: Id }> | undefined {
  return segmentsOf(msg, id)[0];
}
