type Attributes = Record<string, string | number | boolean | EventListener>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: (Node | string)[]
) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'function') node.addEventListener(key, value);
    else if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

export function select(options: [string, string][], value: string, change: (value: string) => void) {
  const node = el('select', { change: () => change(node.value) });
  node.append(...options.map(([v, text]) => el('option', { value: v }, text)));
  node.value = value;
  return node;
}
