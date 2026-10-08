// The selected objects of the open map (ids, in the order they were picked).

export class Selection {
  constructor() {
    this.ids = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.ids);
  }

  has(id) { return this.ids.includes(id); }
  get size() { return this.ids.length; }
  get primary() { return this.ids[this.ids.length - 1] || null; }

  set(ids) {
    const next = [...new Set(ids)];
    if (next.length === this.ids.length && next.every((id, i) => id === this.ids[i])) return;
    this.ids = next;
    this.emit();
  }

  toggle(id) {
    this.set(this.has(id) ? this.ids.filter((x) => x !== id) : [...this.ids, id]);
  }

  clear() { this.set([]); }

  // Drops ids the map no longer has.
  keepExisting(doc) {
    this.set(this.ids.filter((id) => doc.get(id)));
  }
}
