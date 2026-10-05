# @agon/spec

The source of truth for every type in Agon: the `agon.yaml` document, the domain model (environments, runs, sessions, steps, events, results, squads, decisions), and the interfaces the other packages implement (`Adapter`, `LlmClient`, `Recorder`).

Everything is a Zod schema with an inferred TypeScript type. `agonConfigJsonSchema()` exports JSON Schema for editors; `parseAgonConfig()` loads a YAML document with `${ENV}` substitution and readable errors.

Rules of the road:

- Every string key a user chooses (variants, scenarios, metrics, personas) is a `Slug`.
- System identifiers are `<prefix>_<id>`; anything created inside a run derives from the run seed through `deterministicId`.
- Events are rejected unless they carry the simulation markers from `simProperties()`.
- Results always include a `CalibrationNote`.
