import type { Hl7Field } from '../hl7';

/**
 * Prefixes every key of a datatype's relative-key interface: `Prefixed<'pid_5', DT_XPN>` has
 * `pid_5_1_1`, `pid_5_2`, ... Property docs and optionality carry over.
 */
export type Prefixed<P extends string, T> = { [K in keyof T as `${P}_${K & string}`]: T[K] };

/** A Z-segment (site-defined): no typed keys, the fields stay in the lossless positional form. */
export interface Hl7FlatZSegment {
  segment: `Z${string}`;
  fields: Hl7Field[];
}

/**
 * Compact runtime description of one version, emitted by the generator.
 * - `composites[dt]` lists the component datatypes of each composite datatype.
 * - `segments[id][n - 1]` is the datatype of field n; a trailing `*` marks a repeating field.
 *   Datatypes that are not in `composites` are primitive (leaf strings).
 */
export interface Hl7FlatSpec {
  version: string;
  composites: Record<string, string[]>;
  segments: Record<string, string[]>;
}
