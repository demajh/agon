import { findBuiltinPersonaDir, loadPersonaDir } from '@agon/engine';
import type { Output } from '../output.js';

export function personasListCommand(out: Output): number {
  const dir = findBuiltinPersonaDir();
  if (!dir) {
    out.fail('built-in persona library not found (set AGON_PERSONAS_DIR)');
    return 1;
  }
  const personas = [...loadPersonaDir(dir).values()];
  if (out.options.json) {
    out.json(personas);
    return 0;
  }
  out.heading(`${personas.length} built-in personas ${out.dim(`(${dir})`)}`);
  out.table(
    ['id', 'name', 'device', 'patience', 'attention', 'tags'],
    personas.map((p) => [
      `builtin/${p.id}`,
      p.name,
      p.device,
      p.traits.patience.toFixed(2),
      p.traits.attention.toFixed(2),
      p.tags.join(','),
    ]),
  );
  return 0;
}

export function personasShowCommand(out: Output, id: string): number {
  const dir = findBuiltinPersonaDir();
  if (!dir) {
    out.fail('built-in persona library not found (set AGON_PERSONAS_DIR)');
    return 1;
  }
  const personas = loadPersonaDir(dir);
  const persona = personas.get(id.replace(/^builtin\//, ''));
  if (!persona) {
    out.fail(`no built-in persona "${id}" (available: ${[...personas.keys()].join(', ')})`);
    return 1;
  }
  if (out.options.json) {
    out.json(persona);
    return 0;
  }
  out.heading(`${persona.name} ${out.dim(`builtin/${persona.id}`)}`);
  out.text(persona.summary.trim());
  out.text();
  out.table(
    ['trait', 'value'],
    Object.entries(persona.traits).map(([k, v]) => [
      k,
      typeof v === 'number' ? v.toFixed(2) : String(v),
    ]),
  );
  if (persona.goals.length) out.text(`\ngoals: ${persona.goals.join('; ')}`);
  if (persona.frustrations.length) out.text(`frustrations: ${persona.frustrations.join('; ')}`);
  out.text(
    `device: ${persona.device} · locale: ${persona.locale} · tags: ${persona.tags.join(', ') || 'none'}`,
  );
  return 0;
}
