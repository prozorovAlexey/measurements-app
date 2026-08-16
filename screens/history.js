// Заглушка каркаса T1. Экран реализуется в T8 (§7.3 спеки).

export const title = 'История';

export async function render(root, params) {
  const key = params && typeof params.key === 'string' ? params.key : '';

  const card = document.createElement('section');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = title;

  const note = document.createElement('p');
  note.className = 'label';
  note.textContent = key
    ? `Экран будет реализован в задаче T8. Замер: ${key}.`
    : 'Экран будет реализован в задаче T8.';

  card.append(heading, note);
  root.append(card);
}

export function destroy() {
  // Слушателей и таймеров нет.
}
