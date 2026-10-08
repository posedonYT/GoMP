// Undo and redo. An entry is { label, undo(), redo() }. Steps with the same
// merge key that follow each other (dragging with the gizmo, typing a number)
// become one entry: undo goes back to where the drag started.

export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  // Records an action that has already been done.
  push(entry, mergeKey = null) {
    const last = this.done[this.done.length - 1];
    if (mergeKey && last && last.mergeKey === mergeKey && this.undone.length === 0) {
      last.redo = entry.redo;  // the first undo stays: back to the start
    } else {
      this.done.push({ ...entry, mergeKey });
      if (this.done.length > this.limit) this.done.shift();
    }
    this.undone = [];
    this.emit();
  }

  // Closes merging: the next step with the same key is a new entry.
  seal() {
    const last = this.done[this.done.length - 1];
    if (last) last.mergeKey = null;
  }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }

  undo() {
    const e = this.done.pop();
    if (!e) return null;
    e.undo();
    this.undone.push(e);
    this.emit();
    return e.label;
  }

  redo() {
    const e = this.undone.pop();
    if (!e) return null;
    e.redo();
    this.done.push(e);
    this.emit();
    return e.label;
  }

  clear() {
    this.done = [];
    this.undone = [];
    this.emit();
  }
}
