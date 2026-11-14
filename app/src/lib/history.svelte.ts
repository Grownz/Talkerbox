// Undo/redo of editor snapshots, shared by the mask editor and the part editor.

/** Snapshots of type T: `snapshot` reads the current state, `restore` puts one back. Keeps the last 200 steps. */
export class History<T> {
  undoStack = $state.raw<T[]>([])
  redoStack = $state.raw<T[]>([])
  private snapshot: () => T
  private restore: (s: T) => void
  // State before a drag (slider, colour picker) began; pushed as one step when it ends.
  private pending: T | null = null

  constructor(snapshot: () => T, restore: (s: T) => void) {
    this.snapshot = snapshot
    this.restore = restore
  }

  push(s: T) {
    this.undoStack = [...this.undoStack.slice(-199), s]
    this.redoStack = []
  }
  /** Records the current state as an undo step (call before changing it). */
  commit() {
    this.push(this.snapshot())
  }
  undo() {
    if (!this.undoStack.length) return
    const s = this.undoStack.at(-1)!
    this.redoStack = [...this.redoStack, this.snapshot()]
    this.undoStack = this.undoStack.slice(0, -1)
    this.restore(s)
  }
  redo() {
    if (!this.redoStack.length) return
    const s = this.redoStack.at(-1)!
    this.undoStack = [...this.undoStack, this.snapshot()]
    this.redoStack = this.redoStack.slice(0, -1)
    this.restore(s)
  }
  /** A drag is one undo step: `begin` on every input keeps the state from before the first, `end` pushes it. */
  begin() {
    this.pending ??= this.snapshot()
  }
  end() {
    if (this.pending !== null) this.push(this.pending)
    this.pending = null
  }
  /** Forgets all steps (a freshly loaded document). */
  clear() {
    this.undoStack = []
    this.redoStack = []
  }
}
