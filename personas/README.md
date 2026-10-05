# Built-in persona library

Each file is one persona in the `PersonaSchema` shape from `@agon/spec`. Reference them from `agon.yaml` as `builtin/<id>` (the `id` field, which matches the filename). Copy one next to your config and reference it by path (`./personas/my-user.yaml`) to customize.

Traits in [0, 1] are behavioural knobs, not labels: `patience` controls how many fruitless steps the user tolerates, `attention` how much of a page they take in, `domainFamiliarity` how much jargon they understand, `riskTolerance` how readily they hand over data or pay, `priceSensitivity` how hard they look for a price. The engine turns these into perception limits and an abandonment policy; the calibration loop tunes them.

The `summary` is written in the second person because it is pasted into the agent prompt verbatim.

## Agent personas

Personas with a `harness` block are AI agents rather than people, for `mcp` and `http` targets. The harness describes the loop (`react`, `plan-execute`, `single-shot`), the tool-call budget, how many retries before changing approach, parallel tool use, whether the agent confirms before destructive calls, how carefully it reads descriptions and schemas, and its prior exposure to this server. The bundled set (`terminal-coding-agent`, `ide-assistant-agent`, `autonomous-planner-agent`, `minimal-loop-agent`, `cautious-enterprise-agent`, `data-pipeline-agent`) models the harness styles common in the wild without naming any product; calibrate them against real harness runs before trusting proportions.
