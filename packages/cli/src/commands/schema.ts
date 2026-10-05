import { agonConfigJsonSchema } from '@agon/spec';
import type { Output } from '../output.js';

/** Prints the JSON Schema for agon.yaml, for editor integration (`# yaml-language-server: $schema=...`). */
export function schemaCommand(out: Output): number {
  out.text(JSON.stringify(agonConfigJsonSchema(), null, 2));
  return 0;
}
