import { html } from 'hono/html';
import type { Html } from '../html.js';

export function notFoundBody(path: string): Html {
  return html`<div class="container page narrow">
    <h1>Page not found</h1>
    <p class="lede">
      There is nothing at <code>${path}</code>. It may have moved, or the link may be wrong.
    </p>
    <p><a class="btn btn-primary" href="/">Back to the home page</a></p>
  </div>`;
}

export function errorBody(message: string): Html {
  return html`<div class="container page narrow">
    <h1>Something went wrong</h1>
    <p class="lede">
      Try again in a moment. If it keeps happening, the details below will help us fix it.
    </p>
    <details>
      <summary>Technical details</summary>
      <pre>${message}</pre>
    </details>
    <p><a class="btn btn-primary" href="/">Back to the home page</a></p>
  </div>`;
}
