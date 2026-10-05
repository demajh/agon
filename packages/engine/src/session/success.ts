import type { AgonEvent, Observation, SuccessCriterion } from '@agon/spec';

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function urlMatches(url: string, pattern: string): boolean {
  if (pattern.includes('*')) {
    const re = globToRegExp(pattern);
    if (re.test(url)) return true;
    try {
      return re.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }
  return url.includes(pattern);
}

/** Ground truth for a session, independent of what the simulated user believes. */
export function criterionMet(
  criterion: SuccessCriterion,
  observation: Observation | undefined,
  events: readonly AgonEvent[],
): boolean {
  switch (criterion.type) {
    case 'event':
      return events.some((e) => e.event === criterion.name);
    case 'url':
      return observation !== undefined && urlMatches(observation.url, criterion.pattern);
    case 'text':
      return (
        observation !== undefined &&
        observation.text.toLowerCase().includes(criterion.contains.toLowerCase())
      );
    case 'judge':
      return false;
  }
}
