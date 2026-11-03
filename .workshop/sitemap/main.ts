function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing sitemap element: ${selector}`);
  return found;
}

const input = element<HTMLInputElement>('#sitemap-search');
const clear = element<HTMLButtonElement>('.clear-search');
const empty = element('.empty');
const status = element('#search-status');
const items = [...document.querySelectorAll<HTMLElement>('[data-item]')];
const sections = [...document.querySelectorAll<HTMLElement>('[data-section]')];
const groups = [...document.querySelectorAll<HTMLElement>('[data-group]')];
const normalize = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
const index = new Map(items.map((item) => [item, normalize(item.dataset.search ?? '')]));

function update(): void {
  const query = normalize(input.value.trim());
  const words = query.split(/\s+/u).filter(Boolean);
  let matches = 0;
  for (const item of items) {
    item.hidden = !words.every((word) => (index.get(item) ?? '').includes(word));
    if (!item.hidden) matches += 1;
  }
  for (const group of groups) {
    group.hidden = ![...group.querySelectorAll<HTMLElement>('[data-item]')].some(
      (item) => !item.hidden,
    );
  }
  for (const section of sections) {
    const count = [...section.querySelectorAll<HTMLElement>('[data-item]')].filter(
      (item) => !item.hidden,
    ).length;
    section.hidden = count === 0;
    const counter = section.querySelector('[data-count]');
    if (counter) counter.textContent = String(count);
  }
  clear.hidden = !input.value;
  empty.hidden = matches > 0;
  status.textContent = query ? `${matches} ${matches === 1 ? 'result' : 'results'}` : '';
}

input.addEventListener('input', update);
clear.addEventListener('click', () => {
  input.value = '';
  update();
  input.focus();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && input.value) {
    input.value = '';
    update();
  }
});

// Browsers may restore a search when returning from an App/About link.
window.addEventListener('pageshow', update);
update();

// A module, so its bindings (status among them) stay out of the global scope.
export {};
