// Заглушка каркаса T1. Экран реализуется в T4 (§7.1 спеки).

export const title = 'Шпаргалка';

export async function render(root, params) {
  const card = document.createElement('section');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = title;

  const note = document.createElement('p');
  note.className = 'label';
  note.textContent = 'Экран будет реализован в задаче T4.';

  card.append(heading, note);
  root.append(card);
}

export function destroy() {
  // Слушателей и таймеров нет.
}
