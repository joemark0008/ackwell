# HL7 v2 test fixtures

Synthetic messages (no real patient data). Each file is stored exactly as it goes on the wire inside
the MLLP frame: segments separated by a single `\r` (CR), **no** trailing CR, no MLLP framing bytes.
Keep it that way when editing (many editors convert CR to LF; check with `od -c`).

| File | MSH-12 | Type | Exercises |
|---|---|---|---|
| `adt_a01_v2.3.hl7` | 2.3 | ADT^A01 | Field repeats (PID-3 two identifiers, PID-13 two phone numbers, one with components), EVN/PID/NK1/PV1/IN1, empty fields in the middle, trailing empty components (`ACME INSURANCE^^`) |
| `oru_r01_v2.5.1.hl7` | 2.5.1 | ORU^R01^ORU_R01 | Several OBX (NM, ST, TX); OBX-4 carries every escape `\F\ \S\ \T\ \R\ \E\`; OBX-5 carries a `\X0D\` hex escape; empty fields; trailing empty fields (`F|||`); NTE with a repeat |
| `orm_o01_v2.4.hl7` | 2.4 | ORM^O01 | Subcomponents `&` (PID-3.4, ORC-12 assigning authority, OBR-15 specimen source), ORC quantity/timing with leading empty components, DG1. 2.4 has no typed flat format: lossless round-trip only |
| `siu_s12_v2.3.hl7` | 2.3 | SIU^S12 | Scheduling: SCH/PID/PV1/RGS/AIS/AIG/AIL/AIP, long runs of empty fields |
| `adt_a08_zseg_custom_delims_v2.5.1.hl7` | 2.5.1 | ADT^A08^ADT_A01 | Custom delimiters `MSH#*+!%` (field `#`, component `*`, repeat `+`, escape `!`, subcomponent `%`), Z-segments `ZPD` / `ZIN` after PID (with components, subcomponents and an `!F!` escape), PV1 after the Z-segments |

Used by `packages/schemas/src/hl7-fixtures.test.ts` (codec round-trip, typed flat round-trip) and
`apps/api/test/qa-gaps.e2e.test.ts` (sent over MLLP to an inbound channel, stored `raw` must equal the file).
