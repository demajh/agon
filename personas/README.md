# Built-in persona library

Each file is one persona in the `PersonaSchema` shape from `@agon/spec`. Reference them from `agon.yaml` as `builtin/<id>` (the `id` field, which matches the filename). Copy one next to your config and reference it by path (`./personas/my-user.yaml`) to customize.

Traits in [0, 1] are behavioural knobs, not labels: `patience` controls how many fruitless steps the user tolerates, `attention` how much of a page they take in, `domainFamiliarity` how much jargon they understand, `riskTolerance` how readily they hand over data or pay, `priceSensitivity` how hard they look for a price. The engine turns these into perception limits and an abandonment policy; the calibration loop tunes them.

The `summary` is written in the second person because it is pasted into the agent prompt verbatim.
