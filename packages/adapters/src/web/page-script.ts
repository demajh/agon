/**
 * The DOM walker that runs inside the page through `page.evaluate`. Playwright serialises the
 * function source and re-evaluates it in the browser, so `collectPageState` must stay
 * self-contained: no imports, no references to anything outside its own body except DOM globals.
 */

export interface PageScriptOptions {
  /** Attribute that carries the stable element ref, e.g. `data-agon-ref`. */
  refAttribute: string;
  /** Stop after this many interactive elements (document order). */
  maxElements: number;
  maxNameChars: number;
  maxValueChars: number;
  /** How many `<select>` options to list in the element name. */
  maxOptions: number;
}

export interface PageScriptElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  disabled: boolean;
  checked?: boolean;
}

export interface PageScriptResult {
  url: string;
  title: string;
  text: string;
  interactive: PageScriptElement[];
}

export function collectPageState(opts: PageScriptOptions): PageScriptResult {
  const WIDGET_ROLES = new Set([
    'button',
    'link',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'option',
    'textbox',
    'searchbox',
    'listbox',
    'slider',
    'spinbutton',
    'treeitem',
  ]);
  const TOGGLE_ROLES = new Set([
    'checkbox',
    'radio',
    'switch',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'tab',
  ]);
  const ALWAYS_CHECKABLE = new Set([
    'checkbox',
    'radio',
    'switch',
    'menuitemcheckbox',
    'menuitemradio',
  ]);
  const SELECTOR =
    'a[href], button, summary, input, select, textarea, [role], [contenteditable], [onclick], [tabindex]';

  const squash = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const clip = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

  const explicitRole = (el: Element): string | undefined => {
    const raw = el.getAttribute('role');
    if (!raw) return undefined;
    const first = raw.trim().split(/\s+/)[0];
    return first ? first.toLowerCase() : undefined;
  };

  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')
        return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'file') return 'file';
      if (
        type === 'color' ||
        type === 'date' ||
        type === 'datetime-local' ||
        type === 'month' ||
        type === 'time' ||
        type === 'week'
      ) {
        return type;
      }
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return 'clickable';
  };

  const shouldInclude = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') return false;
    if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
    if (tag === 'a') return el.hasAttribute('href');
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary')
      return true;
    const role = explicitRole(el);
    if (role !== undefined && WIDGET_ROLES.has(role)) return true;
    if ((el as HTMLElement).isContentEditable === true) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex')) {
      const index = (el as HTMLElement).tabIndex;
      return typeof index === 'number' && index >= 0;
    }
    return false;
  };

  const isVisible = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"]') !== null) return false;
    if (el.closest('[inert]') !== null) return false;
    if (el.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(el);
    if (
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.display === 'none'
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  /** Text of a label-like node without the text the control itself renders (e.g. a select's option). */
  const textExcludingControls = (root: Node, skip: Element): string => {
    let out = '';
    const walk = (node: Node): void => {
      if (node === skip) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out += `${node.textContent ?? ''} `;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = (node as Element).tagName.toLowerCase();
      if (tag === 'select' || tag === 'script' || tag === 'style' || tag === 'textarea') return;
      for (const child of Array.from(node.childNodes)) walk(child);
    };
    walk(root);
    return squash(out);
  };

  const baseName = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = squash(
        labelledBy
          .split(/\s+/)
          .map((id) => {
            const target = document.getElementById(id);
            return target ? textExcludingControls(target, el) : '';
          })
          .join(' '),
      );
      if (text) return text;
    }
    const ariaLabel = squash(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const isControl = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (isControl) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const text = squash(
          Array.from(labels)
            .map((label) => textExcludingControls(label, el))
            .join(' '),
        );
        if (text) return text;
      }
    }
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      if (input.type === 'button' || input.type === 'submit' || input.type === 'reset') {
        const value = squash(input.value);
        if (value) return value;
        return input.type === 'submit' ? 'Submit' : input.type === 'reset' ? 'Reset' : '';
      }
      if (input.type === 'image') {
        const alt = squash(input.alt);
        if (alt) return alt;
      }
      const placeholder = squash(input.placeholder);
      if (placeholder) return placeholder;
    } else if (tag === 'textarea') {
      const placeholder = squash((el as HTMLTextAreaElement).placeholder);
      if (placeholder) return placeholder;
    } else if (!isControl) {
      const text = squash((el as HTMLElement).innerText ?? el.textContent);
      if (text) return text;
      const named = el.querySelector('img[alt], [aria-label], svg > title');
      if (named) {
        const inner = squash(
          named.getAttribute('alt') ?? named.getAttribute('aria-label') ?? named.textContent,
        );
        if (inner) return inner;
      }
    }
    const alt = squash(el.getAttribute('alt'));
    if (alt) return alt;
    const title = squash(el.getAttribute('title'));
    if (title) return title;
    const nameAttribute = squash(el.getAttribute('name'));
    if (nameAttribute) return nameAttribute;
    return '';
  };

  const withOptions = (name: string, select: HTMLSelectElement): string => {
    const labels = Array.from(select.options)
      .slice(0, opts.maxOptions)
      .map((option) => squash(option.label || option.text || option.value))
      .filter((label) => label !== '');
    if (labels.length === 0) return name;
    const more = select.options.length > opts.maxOptions ? ', …' : '';
    const suffix = `(options: ${labels.join(', ')}${more})`;
    return name ? `${name} ${suffix}` : suffix;
  };

  const accessibleName = (el: Element): string => {
    const name = baseName(el);
    return el instanceof HTMLSelectElement ? withOptions(name, el) : name;
  };

  const valueOf = (el: Element, role: string): string | undefined => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const selected = Array.from(select.selectedOptions).map(
        (option) => option.label || option.text || option.value,
      );
      return clip(squash(selected.join(', ')), opts.maxValueChars);
    }
    if (tag === 'textarea')
      return clip(squash((el as HTMLTextAreaElement).value), opts.maxValueChars);
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const type = input.type;
      if (
        type === 'button' ||
        type === 'submit' ||
        type === 'reset' ||
        type === 'image' ||
        type === 'checkbox' ||
        type === 'radio' ||
        type === 'file'
      ) {
        return undefined;
      }
      if (type === 'password') return '•'.repeat(Math.min(input.value.length, 32));
      return clip(squash(input.value), opts.maxValueChars);
    }
    if ((el as HTMLElement).isContentEditable === true) {
      return clip(squash((el as HTMLElement).innerText), opts.maxValueChars);
    }
    const valueText = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow');
    if (valueText !== null) return squash(valueText);
    if (role === 'combobox' || role === 'textbox' || role === 'searchbox') {
      const value = (el as unknown as { value?: unknown }).value;
      if (typeof value === 'string') return clip(squash(value), opts.maxValueChars);
    }
    return undefined;
  };

  const checkedOf = (el: Element, role: string): boolean | undefined => {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      return el.checked;
    }
    if (TOGGLE_ROLES.has(role)) {
      const state = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
      if (state === 'true') return true;
      if (state === 'false') return false;
      return ALWAYS_CHECKABLE.has(role) ? false : undefined;
    }
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    return undefined;
  };

  const isDisabled = (el: Element): boolean =>
    el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';

  const refStore = window as unknown as { __agonRefSeq?: number };
  let seq = typeof refStore.__agonRefSeq === 'number' ? refStore.__agonRefSeq : 0;
  const used = new Set<string>();
  const interactive: PageScriptElement[] = [];

  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (interactive.length >= opts.maxElements) break;
    if (!shouldInclude(el) || !isVisible(el)) continue;

    let ref = el.getAttribute(opts.refAttribute);
    if (!ref || used.has(ref) || !/^e\d+$/.test(ref)) {
      seq += 1;
      ref = `e${seq}`;
      el.setAttribute(opts.refAttribute, ref);
    }
    used.add(ref);

    const explicit = explicitRole(el);
    const role = explicit !== undefined && WIDGET_ROLES.has(explicit) ? explicit : implicitRole(el);
    const item: PageScriptElement = {
      ref,
      role,
      name: clip(accessibleName(el), opts.maxNameChars),
      disabled: isDisabled(el),
    };
    const value = valueOf(el, role);
    if (value !== undefined) item.value = value;
    if (el instanceof HTMLAnchorElement && el.href) item.href = el.href.slice(0, 500);
    const checked = checkedOf(el, role);
    if (checked !== undefined) item.checked = checked;
    interactive.push(item);
  }
  refStore.__agonRefSeq = seq;

  const body = document.body;
  let text = body ? body.innerText : '';
  if (!text || text.trim() === '') text = body?.textContent ?? '';

  return { url: location.href, title: document.title, text, interactive };
}
