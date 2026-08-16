// Заглушка каркаса T1. Экран реализуется в T8 (§7.4 спеки).

export const title = 'Настройки';

export async function render(root, params) {
  const card = document.createElement('section');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = title;

  const note = document.createElement('p');
  note.className = 'label';
  note.textContent = 'Экран будет реализован в задаче T8.';

  card.append(heading, note);
  root.append(card);
}

export function destroy() {
  // Слушателей и таймеров нет.
}
