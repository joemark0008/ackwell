import { z } from 'zod';

/**
 * Generic, lossless HL7 v2 ↔ JSON codec.
 *
 * Shape (segments → fields → repeats → components → subcomponents):
 *
 *   {
 *     delimiters: { field: '|', component: '^', repeat: '~', escape: '\\', subcomponent: '&' },
 *     segments: [
 *       { id: 'MSH', fields: ['|', '^~\\&', 'LAB', ...] },     // fields[0] = MSH-1, fields[1] = MSH-2 (raw)
 *       { id: 'PID', fields: ['1', '', ['123', '', '', 'HOSP', 'MR'], '', ['DOE', 'JANE']] },
 *       { id: 'OBX', fields: ['1', 'ST', 'NOTE', '', { repeat: ['a', 'b'] }] },
 *     ]
 *   }
 *
 * Rules
 * - `fields[i]` is field `i + 1` (`PID-5` → `fields[4]`). Empty fields are `''` and are kept, so positions never shift.
 * - A field with no `^`, `~` or `&` is a plain string. With components it is an array; a component with
 *   subcomponents is itself an array of strings.
 * - A field with repeats (`~`) is `{ repeat: [...] }`, each repeat being a plain field value.
 * - Leaves keep HL7 escape sequences (`\F\`, `\S\`, `\T\`, `\R\`, `\E\`, `\Xdd\`…) untouched. Decode them only
 *   when you display or map a value; that keeps the JSON byte-for-byte rebuildable.
 * - MSH-1 and MSH-2 are stored raw (never split), so custom delimiters round-trip too.
 * - Segment separators (`\r`, `\n`, `\r\n`) are normalised to `\r` on build. Trailing separators are dropped.
 */

export interface Hl7Delimiters {
  field: string;
  component: string;
  repeat: string;
  escape: string;
  subcomponent: string;
}

/** A component: a string, or subcomponents. */
export type Hl7Component = string | string[];
/** A single field value (one repeat): a string, or components. */
export type Hl7FieldValue = string | Hl7Component[];
/** A field: one value, or several repeats. */
export type Hl7Field = Hl7FieldValue | { repeat: Hl7FieldValue[] };

export interface Hl7Segment {
  id: string;
  fields: Hl7Field[];
}

export interface Hl7Json {
  delimiters: Hl7Delimiters;
  segments: Hl7Segment[];
}

export const DEFAULT_DELIMITERS: Hl7Delimiters = {
  field: '|',
  component: '^',
  repeat: '~',
  escape: '\\',
  subcomponent: '&',
};

const oneChar = z.string().length(1);
export const hl7DelimitersSchema = z.object({
  field: oneChar,
  component: oneChar,
  repeat: oneChar,
  escape: oneChar,
  subcomponent: oneChar,
});

const hl7ComponentSchema: z.ZodType<Hl7Component> = z.union([z.string(), z.array(z.string())]);
const hl7FieldValueSchema: z.ZodType<Hl7FieldValue> = z.union([z.string(), z.array(hl7ComponentSchema)]);
export const hl7FieldSchema: z.ZodType<Hl7Field> = z.union([
  hl7FieldValueSchema,
  z.object({ repeat: z.array(hl7FieldValueSchema).min(1) }).strict(),
]);

export const hl7SegmentSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(3)
    .regex(/^[A-Z][A-Z0-9]{2}$/, 'Segment id must be 3 characters, e.g. MSH, PID, Z01'),
  fields: z.array(hl7FieldSchema),
});

/** Full JSON message. `delimiters` may be omitted on input (defaults apply). */
export const hl7JsonSchema = z.object({
  delimiters: hl7DelimitersSchema.default(DEFAULT_DELIMITERS),
  segments: z.array(hl7SegmentSchema).min(1),
});
export type Hl7JsonInput = z.input<typeof hl7JsonSchema>;

export class Hl7ParseError extends Error {
  override name = 'Hl7ParseError';
}

const SEGMENT_SPLIT = /\r\n|\r|\n/;

/** Reads the delimiters from an MSH header line ("MSH|^~\&|…"). */
export function readDelimiters(msh: string): Hl7Delimiters {
  if (!msh.startsWith('MSH') || msh.length < 8) {
    throw new Hl7ParseError('Message must start with an MSH segment followed by the delimiters');
  }
  const field = msh[3]!;
  const enc = msh.slice(4, 8);
  const [component, repeat, escape, subcomponent] = enc;
  const all = [field, component, repeat, escape, subcomponent];
  if (new Set(all).size !== 5 || all.some((c) => c === undefined || /[\r\n]/.test(c))) {
    throw new Hl7ParseError(`Invalid delimiters "${msh.slice(3, 8)}" in MSH`);
  }
  return { field, component: component!, repeat: repeat!, escape: escape!, subcomponent: subcomponent! };
}

/** HL7 text → lossless JSON. Accepts \r, \n or \r\n between segments. */
export function parseHl7(raw: string): Hl7Json {
  const lines = raw.split(SEGMENT_SPLIT).filter((l, i, arr) => !(l === '' && i === arr.length - 1));
  // Allow a leading blank line (some senders prefix with \n), but nothing else before MSH.
  while (lines.length && lines[0] === '') lines.shift();
  if (!lines.length) throw new Hl7ParseError('Empty message');
  const delimiters = readDelimiters(lines[0]!);
  const segments: Hl7Segment[] = lines.map((line, i) => parseSegment(line, delimiters, i));
  return { delimiters, segments };
}

function parseSegment(line: string, d: Hl7Delimiters, index: number): Hl7Segment {
  const id = line.slice(0, 3);
  if (!/^[A-Z][A-Z0-9]{2}$/.test(id)) {
    throw new Hl7ParseError(`Segment ${index + 1} has an invalid id "${id}"`);
  }
  if (line.length > 3 && line[3] !== d.field) {
    throw new Hl7ParseError(`Segment ${index + 1} (${id}) is not followed by the field separator`);
  }
  const rest = line.slice(4);
  if (id === 'MSH') {
    // MSH-1 is the field separator itself and MSH-2 is the encoding characters: both stay raw.
    const enc = rest.slice(0, 4);
    const tail = rest.slice(4);
    const fields: Hl7Field[] = [d.field, enc];
    if (tail.length) {
      if (tail[0] !== d.field) throw new Hl7ParseError('MSH-2 must be exactly four encoding characters');
      for (const f of tail.slice(1).split(d.field)) fields.push(parseField(f, d));
    }
    return { id, fields };
  }
  if (line.length === 3) return { id, fields: [] };
  return { id, fields: rest.split(d.field).map((f) => parseField(f, d)) };
}

function parseField(text: string, d: Hl7Delimiters): Hl7Field {
  if (text.includes(d.repeat)) {
    return { repeat: text.split(d.repeat).map((r) => parseFieldValue(r, d)) };
  }
  return parseFieldValue(text, d);
}

function parseFieldValue(text: string, d: Hl7Delimiters): Hl7FieldValue {
  if (!text.includes(d.component) && !text.includes(d.subcomponent)) return text;
  return text.split(d.component).map((c) => (c.includes(d.subcomponent) ? c.split(d.subcomponent) : c));
}

/** Lossless JSON → HL7 text (segments joined with \r, no trailing separator). Throws on invalid shapes. */
export function buildHl7(input: Hl7JsonInput): string {
  const msg = hl7JsonSchema.parse(input);
  const d = msg.delimiters;
  if (msg.segments[0]!.id !== 'MSH') throw new Hl7ParseError('First segment must be MSH');
  return msg.segments.map((s) => buildSegment(s, d)).join('\r');
}

function buildSegment(s: Hl7Segment, d: Hl7Delimiters): string {
  if (s.id === 'MSH') {
    const [f1, f2, ...rest] = s.fields;
    if (f1 !== d.field) throw new Hl7ParseError(`MSH-1 must equal the field separator "${d.field}"`);
    const enc = `${d.component}${d.repeat}${d.escape}${d.subcomponent}`;
    if (f2 !== enc) throw new Hl7ParseError(`MSH-2 must equal the encoding characters "${enc}"`);
    const tail = rest.map((f) => buildField(f, d));
    return ['MSH' + d.field + enc, ...tail].join(d.field);
  }
  if (!s.fields.length) return s.id;
  return s.id + d.field + s.fields.map((f) => buildField(f, d)).join(d.field);
}

function buildField(f: Hl7Field, d: Hl7Delimiters): string {
  if (typeof f === 'object' && !Array.isArray(f)) return f.repeat.map((r) => buildFieldValue(r, d)).join(d.repeat);
  return buildFieldValue(f, d);
}

function buildFieldValue(v: Hl7FieldValue, d: Hl7Delimiters): string {
  if (typeof v === 'string') return v;
  return v.map((c) => (Array.isArray(c) ? c.join(d.subcomponent) : c)).join(d.component);
}

// ---- Convenience accessors -------------------------------------------------------------------------

/** First repeat of a field as components (a plain string becomes a one-element array). */
export function fieldComponents(field: Hl7Field | undefined): Hl7Component[] {
  if (field === undefined) return [];
  const v = typeof field === 'object' && !Array.isArray(field) ? field.repeat[0] : field;
  if (v === undefined) return [];
  return typeof v === 'string' ? [v] : v;
}

/** Flattened text of a field, as it appears in the raw message (repeats and components rejoined). */
export function fieldText(field: Hl7Field | undefined, d: Hl7Delimiters = DEFAULT_DELIMITERS): string {
  return field === undefined ? '' : buildField(field, d);
}

export function findSegment(msg: Hl7Json, id: string): Hl7Segment | undefined {
  return msg.segments.find((s) => s.id === id);
}

/** `SEG-n` (1-based) of the first matching segment. */
export function getField(msg: Hl7Json, segmentId: string, n: number): Hl7Field | undefined {
  return findSegment(msg, segmentId)?.fields[n - 1];
}

/** "ORU^R01" style message type from MSH-9 (first two components), or null when absent. */
export function messageTypeOf(msg: Hl7Json): string | null {
  const [type, trigger] = fieldComponents(getField(msg, 'MSH', 9)).map((c) => (Array.isArray(c) ? c[0] ?? '' : c));
  if (!type) return null;
  return trigger ? `${type}^${trigger}` : type;
}

/** MSH-10 message control id, or null. */
export function controlIdOf(msg: Hl7Json): string | null {
  const v = fieldText(getField(msg, 'MSH', 10), msg.delimiters);
  return v || null;
}

/** MSH-12 version id, or null. */
export function versionOf(msg: Hl7Json): string | null {
  const [v] = fieldComponents(getField(msg, 'MSH', 12));
  const s = Array.isArray(v) ? v[0] : v;
  return s || null;
}

/** Decodes the standard HL7 escape sequences of one leaf value for display. */
export function unescapeHl7(value: string, d: Hl7Delimiters = DEFAULT_DELIMITERS): string {
  const e = d.escape;
  if (!value.includes(e)) return value;
  const re = new RegExp(`${escapeRegex(e)}([^${escapeRegex(e)}]*)${escapeRegex(e)}`, 'g');
  return value.replace(re, (whole, code: string) => {
    switch (code) {
      case 'F':
        return d.field;
      case 'S':
        return d.component;
      case 'T':
        return d.subcomponent;
      case 'R':
        return d.repeat;
      case 'E':
        return d.escape;
      case '.br':
        return '\n';
      default:
        if (/^X(?:[0-9A-Fa-f]{2})+$/.test(code)) {
          const hex = code.slice(1);
          let out = '';
          for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
          return out;
        }
        return whole;
    }
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
