const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), s => s.segment);
type Snapshot = { text: string; row: number; col: number };
export type Position = { row: number; col: number };
export type SearchResult = { found: boolean; wrapped: boolean };

const BLANK = 0, EMPTY = -1;
// Vim-like word classes: blank, keyword, punctuation, CJK, emoji. WORDs only split on blanks.
function wordClass(g: string | undefined, big: boolean): number {
  if (g === undefined) return EMPTY;
  if (/^\s/.test(g)) return BLANK;
  if (big) return 1;
  if (/\p{Extended_Pictographic}/u.test(g)) return 4;
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(g)) return 3;
  if (/^[\p{L}\p{N}\p{M}_]/u.test(g)) return 1;
  return 2;
}

/** Small document buffer. Columns count graphemes, never UTF-16 code units. */
export class DocumentBuffer {
  lines: string[];
  row = 0;
  col = 0;
  mode: "normal" | "insert" | "visual" = "normal";
  anchor?: Position;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private register = "";
  private linewise = false;

  constructor(text: string) { this.lines = text.split("\n"); }
  get text(): string { return this.lines.join("\n"); }
  private snapshot(): Snapshot { return { text: this.text, row: this.row, col: this.col }; }
  private restore(s: Snapshot): void {
    this.lines = s.text.split("\n"); this.row = s.row; this.col = s.col;
    this.anchor = undefined; this.mode = "normal"; this.clamp();
  }
  private change(fn: () => void): void {
    const before = this.snapshot(); fn(); this.clamp();
    if (before.text !== this.text) {
      this.undoStack.push(before);
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    }
  }
  clamp(): void {
    this.row = Math.max(0, Math.min(this.lines.length - 1, this.row));
    this.col = Math.max(0, Math.min(graphemes(this.lines[this.row]).length, this.col));
  }
  move(dr: number, dc: number): void { this.row += dr; this.col += dc; this.clamp(); }
  private step(p: Position, forward: boolean): Position | undefined {
    if (forward) {
      if (p.col < graphemes(this.lines[p.row]).length - 1) return { row: p.row, col: p.col + 1 };
      return p.row < this.lines.length - 1 ? { row: p.row + 1, col: 0 } : undefined;
    }
    if (p.col > 0) return { row: p.row, col: p.col - 1 };
    return p.row > 0 ? { row: p.row - 1, col: Math.max(0, graphemes(this.lines[p.row - 1]).length - 1) } : undefined;
  }
  /** w/e/b and W/E/B. Words never span lines; an empty line is a stop for w and b. */
  word(motion: "w" | "e" | "b", big = false): void {
    const at = (p: Position) => wordClass(graphemes(this.lines[p.row])[p.col], big);
    let p: Position = { row: this.row, col: Math.min(this.col, Math.max(0, graphemes(this.lines[this.row]).length - 1)) };
    let n: Position | undefined;
    const run = (forward: boolean) => {
      const kind = at(p);
      while ((n = this.step(p, forward)) && n.row === p.row && at(n) === kind) p = n;
    };
    if (motion === "w") {
      if (at(p) > BLANK) run(true);
      if ((n = this.step(p, true))) {
        p = n;
        while (at(p) === BLANK && (n = this.step(p, true))) p = n;
      }
    } else if (motion === "e") {
      if (!(n = this.step(p, true))) return;
      p = n;
      while (at(p) <= BLANK && (n = this.step(p, true))) p = n;
      run(true);
    } else {
      if (!(n = this.step(p, false))) { this.col = 0; return; }
      p = n;
      while (at(p) === BLANK && (n = this.step(p, false))) p = n;
      if (at(p) > BLANK) run(false);
    }
    this.row = p.row; this.col = p.col; this.clamp();
  }
  /** Case-sensitive literal search from the cursor, wrapping around the document. */
  search(query: string, forward = true): SearchResult {
    if (!query) return { found: false, wrapped: false };
    const text = this.text, here = this.offset({ row: this.row, col: this.col });
    // Matches must start on a grapheme boundary, so "e" never lands inside a decomposed "é".
    const boundaries = new Set<number>();
    let offset = 0;
    for (const g of graphemes(text)) { boundaries.add(offset); offset += g.length; }
    boundaries.add(offset);
    const matches: number[] = [];
    for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + 1))
      if (boundaries.has(i) && boundaries.has(i + query.length)) matches.push(i);
    if (!matches.length) return { found: false, wrapped: false };
    let target = forward ? matches.find(i => i > here) : matches.findLast(i => i < here);
    const wrapped = target === undefined;
    target ??= forward ? matches[0] : matches.at(-1)!;
    const before = text.slice(0, target).split("\n");
    this.row = before.length - 1; this.col = graphemes(before.at(-1)!).length; this.clamp();
    return { found: true, wrapped };
  }
  home(): void { this.col = 0; }
  end(): void { this.col = graphemes(this.lines[this.row]).length; }
  insert(text: string): void {
    this.change(() => {
      const chars = graphemes(this.lines[this.row]);
      const inserted = text.replace(/\r\n?/g, "\n").split("\n");
      const before = chars.slice(0, this.col).join("");
      const after = chars.slice(this.col).join("");
      const replacement = [...inserted];
      replacement[0] = before + replacement[0];
      replacement[replacement.length - 1] += after;
      this.lines.splice(this.row, 1, ...replacement);
      this.row += inserted.length - 1;
      this.col = inserted.length === 1 ? this.col + graphemes(inserted[0]).length : graphemes(inserted.at(-1)!).length;
    });
  }
  backspace(): void {
    this.change(() => {
      if (this.col > 0) {
        const chars = graphemes(this.lines[this.row]); chars.splice(--this.col, 1);
        this.lines[this.row] = chars.join("");
      } else if (this.row > 0) {
        this.col = graphemes(this.lines[this.row - 1]).length;
        this.lines[this.row - 1] += this.lines[this.row]; this.lines.splice(this.row--, 1);
      }
    });
  }
  deleteChar(): void {
    this.change(() => {
      const chars = graphemes(this.lines[this.row]);
      if (this.col < chars.length) { chars.splice(this.col, 1); this.lines[this.row] = chars.join(""); }
      else if (this.row < this.lines.length - 1) { this.lines[this.row] += this.lines.splice(this.row + 1, 1)[0]; }
    });
  }
  openLine(above = false): void {
    this.change(() => { this.lines.splice(this.row + (above ? 0 : 1), 0, ""); if (!above) this.row++; this.col = 0; });
    this.mode = "insert";
  }
  toggleVisual(): void {
    if (this.mode === "visual") this.normal();
    else { this.mode = "visual"; this.anchor = { row: this.row, col: this.col }; }
  }
  normal(): void { this.mode = "normal"; this.anchor = undefined; }
  private offset(p: Position): number {
    return this.lines.slice(0, p.row).reduce((n, line) => n + line.length + 1, 0) + graphemes(this.lines[p.row]).slice(0, p.col).join("").length;
  }
  selection(): [number, number] | undefined {
    if (!this.anchor) return;
    const a = this.offset(this.anchor), b = this.offset({ row: this.row, col: this.col });
    const start = Math.min(a, b), end = Math.max(a, b);
    return [start, Math.min(this.text.length, end + (graphemes(this.text.slice(end))[0]?.length ?? 0))];
  }
  selected(row: number, col: number): boolean {
    const range = this.selection(); if (!range) return false;
    const offset = this.offset({ row, col }); return offset >= range[0] && offset < range[1];
  }
  yank(remove = false): void {
    const range = this.selection();
    if (range) {
      this.register = this.text.slice(...range); this.linewise = false;
      if (remove) this.change(() => {
        const before = this.text.slice(0, range[0]);
        const next = before + this.text.slice(range[1]); this.lines = next.split("\n");
        this.row = before.split("\n").length - 1; this.col = graphemes(before.split("\n").at(-1)!).length;
      });
    } else {
      this.register = this.lines[this.row]; this.linewise = true;
      if (remove) this.change(() => { this.lines.splice(this.row, 1); if (!this.lines.length) this.lines = [""]; this.col = 0; });
    }
    this.normal();
  }
  paste(): void {
    if (this.linewise) this.change(() => { this.lines.splice(++this.row, 0, this.register); this.col = 0; });
    else { this.move(0, 1); this.insert(this.register); }
  }
  undo(): void { const s = this.undoStack.pop(); if (s) { this.redoStack.push(this.snapshot()); this.restore(s); } }
  redo(): void { const s = this.redoStack.pop(); if (s) { this.undoStack.push(this.snapshot()); this.restore(s); } }
  replace(text: string): void { this.restore({ text, row: this.row, col: this.col }); this.undoStack = []; this.redoStack = []; }
}
