# Typed HL7 JSON ("flat" format)

Ackwell has two JSON forms for an HL7 v2 message:

| Form | Shape | Versions | Use |
|---|---|---|---|
| **Lossless** (`json`) | `{ delimiters, segments: [{ id, fields: [...] }] }`, positional | any | storage, exact rebuild, any version |
| **Typed / flat** (`flat`) | `{ msh_9_1, msh_12, segments: [{ segment: 'PID', pid_5: [...] }] }` | **2.3, 2.5.1, 2.7** | readable keys, compile-time types, validation |

The typed form is built from the lossless one (`toFlat`) and converts back (`fromFlat`, `flatToHl7`).

## Supported versions

The list lives in one place: `HL7_FLAT_VERSIONS` in `packages/schemas/src/hl7-flat/index.ts` (exported
from `@ackwell/schemas`, together with `isHl7FlatVersion(v)`). Today: **`2.3`, `2.5.1`, `2.7`**.

Where you can see it:
- **Channel page → Configuration → "Typed JSON"**: says whether the channel's HL7 version has the typed form.
- **Message viewer**: JSON pane shows a *Typed / Lossless* switch only when the message's version is supported.
- **Webhooks**: `flat` is `null` for other versions.

### Webhook JSON format (per inbound channel)

Channel form → Delivery → **JSON format** (`delivery.payload`). `raw` is always sent.

| Value | Body has | Notes |
|---|---|---|
| `both` (default) | `json` + `flat` | what channels created before this option send |
| `typed` | `flat` | if the version has no typed definition, `flat` is `null` and `json` is sent instead |
| `lossless` | `json` | keeps every field, repetition and Z-segment |
- **Send API**: `{ "flat": … }` with another `msh_12` → 400 `msh_12 must be one of 2.3, 2.5.1, 2.7`.
- **TypeScript**: `msh_12` accepts only `'2.3' | '2.5.1' | '2.7'`.

Matching is exact on the **message's own MSH-12** (not the channel setting): `2.5` does not use the `2.5.1` types.

## Format rules

```ts
const msg: Hl7Flat_2_7 = {
  msh_3_1: 'EMR', msh_9_1: 'ADT', msh_9_2: 'A01', msh_11_1: 'P', msh_12: '2.7',
  segments: [
    { segment: 'PID',
      pid_3: [{ pid_3_1: 'MRN1', pid_3_4_1: 'HOSP', pid_3_5: 'MR' }],
      pid_5: [{ pid_5_1_1: 'DOE', pid_5_2: 'JANE' }],
      pid_8_1: 'F' },
    { segment: 'ZPI', fields: ['custom'] },
  ],
};
```

- Keys: `<segment>_<field>[_<component>[_<subcomponent>]]`, lower case, down to the leaves of the field's
  datatype **in that version** (2.3 MSH-7 is `TS` → `msh_7_1`; 2.7 MSH-7 is `DTM` → `msh_7`).
- Exception: the version is always **`msh_12`** (even where MSH-12 is a VID composite), so it can discriminate
  the union `Hl7Flat = Hl7Flat_2_3 | Hl7Flat_2_5_1 | Hl7Flat_2_7`.
- MSH keys are top level; MSH-1/MSH-2 come from `delimiters` (omitted when default).
- Other segments: in order in `segments`, tagged `segment: 'PID'`. Repeating segments appear several times.
- Repeating fields are arrays (`string[]` or objects with the same full keys).
- Z-segments keep the lossless positional form `{ segment: 'ZXX', fields: [...] }`.
- Leaves are raw HL7 text (escapes such as `\F\` kept). Use `escapeHl7()` for free text. Validation rejects
  `\r`, `\n`, the field separator and the repeat separator inside leaves.
- OBX-5 ("varies") is a raw string array; its real type is named by OBX-2.
- Anything outside the version definition (undefined field, too many components, repeats in a non-repeating
  field) goes to the segment's `_extra: { pid_40: '<raw field text>' }`, so nothing is lost.
- Round trip HL7 → flat → HL7 is byte for byte, except trailing empty fields/components are dropped.
- A message with a non-Z segment the version does not define has no flat form (`tryToFlat` → `null`).

## API

From `@ackwell/schemas`:

| Export | Purpose |
|---|---|
| `toFlat(json)` / `tryToFlat(json)` | lossless → typed (throws / returns `null` when unsupported) |
| `fromFlat(flat)` / `flatToHl7(flat)` | typed → lossless JSON / HL7 text (validates first) |
| `validateFlat(v)` / `assertFlat(v)` / `hl7FlatSchema` | runtime checks with paths (`segments[0].pid_5_1_1`) |
| `segmentOf(msg, 'PID')` / `segmentsOf(msg, 'OBX')` | typed lookups |
| `escapeHl7(text)` | escape free text for a leaf |
| `Hl7Flat`, `Hl7Flat_2_3`, `Hl7Flat_2_5_1`, `Hl7Flat_2_7`, `Hl7FlatSegment<'2.7'>` | message types |
| `Hl7v2_3`, `Hl7v2_5_1`, `Hl7v2_7` | per-version namespaces (`Hl7v2_7.PID`, `Hl7v2_7.DT_XPN`, …) |

Wired in: `POST /api/channels/:id/send` accepts `{ "flat": {...} }`; webhook payloads include `flat`; the
dashboard message viewer has a Typed/Lossless switch; the test-send box accepts a bare typed message.

## How it is built

```
hl7-dictionary@1.0.1 (devDependency, MIT)
   └─ packages/schemas/scripts/gen-hl7-flat.mjs
        └─ packages/schemas/src/hl7-flat/generated/v2_3.ts, v2_5_1.ts, v2_7.ts   (committed, do not edit)
             ├─ DT_<datatype> interfaces with relative keys ('1', '1_2', …)
             ├─ one interface per segment (Prefixed<'pid_5', DT_XPN> → pid_5_1_1 …)
             ├─ MSH (top-level keys), Segment union, Message
             └─ spec: compact runtime description used by toFlat / fromFlat / validateFlat
packages/schemas/src/hl7-flat/index.ts   (hand-written runtime + exports)
packages/schemas/src/hl7-flat/types.ts   (Prefixed, Hl7FlatSpec, Hl7FlatZSegment)
```

Corrections to the dictionary go in `FIELD_OVERRIDES` in the generator (today: `OBX-5` → `VARIES`, repeating).

## Adding a version (e.g. 2.4)

`hl7-dictionary` has **2.1, 2.2, 2.3, 2.3.1, 2.4, 2.5, 2.5.1, 2.6, 2.7, 2.7.1**. It has **no 2.8**: that needs
another source (e.g. the HL7 v2+ definitions) converted to the same `{ fields, segments }` shape.

1. `packages/schemas/scripts/gen-hl7-flat.mjs`: add the version to `VERSIONS`.
2. Generate (Node is not on the host):
   ```sh
   docker run --rm -v /root/project/ackwell:/app -w /app node:22-alpine \
     npm run gen:hl7-flat -w @ackwell/schemas
   ```
   This writes `src/hl7-flat/generated/v2_4.ts` and prints any datatypes it treats as primitive because the
   dictionary does not define them; check those look right.
3. `packages/schemas/src/hl7-flat/index.ts`:
   - `import * as V2_4 from './generated/v2_4';`
   - `export { V2_4 as Hl7v2_4 }` and `export type Hl7Flat_2_4 = V2_4.Message;`
   - add `Hl7Flat_2_4` to the `Hl7Flat` union
   - add `'2.4'` to `HL7_FLAT_VERSIONS` and `'2.4': V2_4.spec` to `SPECS`
4. Spot-check the generated segments you use (PID, PV1, OBR, OBX, ORC, …) against the spec, especially
   repeatability; add `FIELD_OVERRIDES` entries for dictionary mistakes and regenerate.
5. Tests in `packages/schemas/src/hl7-flat/hl7-flat.test.ts`: add a real sample of the version to `SAMPLES`
   (the round-trip test then covers it) and one `toFlat` assertion for a version-specific datatype.
6. Update the version lists in this file and in the web test `apps/web/src/components/typed-json-note.test.tsx`
   (the channel page note itself reads `HL7_FLAT_VERSIONS`, so it updates by itself).
7. Run the suite (see HANDOVER "How to run tests") and restart the dev service so it picks up the new
   `@ackwell/schemas` build.

Each version adds roughly 150–320 KB of generated `.ts` and ~30 KB to the runtime bundle (the `spec`).

## Known gaps / ideas

- 2.3 `PID-5` is non-repeating in the dictionary; repeated names from 2.3 senders land in `_extra`.
- Message-structure typing (e.g. `ADT_A01` with groups and required segments) is not generated; the types
  are per segment. The dictionary's `messages` data could drive it later.
- JSON Schema per version for webhook receivers in other languages (could be emitted by the generator).
- Code tables are plain `string` (local tables often extend them); table numbers could go into the JSDoc.
