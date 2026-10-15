export function windowFixture() {
  return {
    id: 7, focused: true, incognito: false, state: 'normal',
    tabs: [
      { id: 1, url: 'https://example.com/a', title: 'A', pinned: false, active: true, groupId: -1 },
      { id: 2, url: 'https://example.com/b', title: 'B – Ärger', pinned: true, active: false, groupId: 5 },
    ],
    groups: [{ id: 5, title: 'Arbeit', color: 'blue', collapsed: false }],
  };
}
