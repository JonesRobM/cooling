/** Undo and redo over serialised states. */
export class History {
  private past: string[] = [];
  private future: string[] = [];

  constructor(private present: string) {}

  commit(state: string): void {
    if (state === this.present) return;
    this.past = [...this.past.slice(-99), this.present];
    this.present = state;
    this.future = [];
  }

  undo(): string | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(this.present);
    return (this.present = previous);
  }

  redo(): string | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    return (this.present = next);
  }
}
