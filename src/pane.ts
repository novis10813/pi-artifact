import { basename } from "node:path";
import { CURSOR_MARKER, renderFakeCursor, visibleWidth, truncateToWidth, matchesKey, decodeKittyPrintable,
  type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DocumentSession } from "./document.ts";
import { graphemes } from "./buffer.ts";

type Theme = { fg(color: "accent" | "muted" | "text" | "warning", text: string): string; bg(color: "selectedBg", text: string): string };
type VisualLine = { row: number; start: number; cells: { text: string; col: number; offset: number }[] };
const safe = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "�");

/** Full-height, focusable source editor. No terminal renderer or subprocess of its own. */
export class DocumentPane implements Component, Focusable {
  focused = false;
  message = "F6: chat / document";
  private top = 0;
  private followCursor = true;
  private pending = "";
  private prompt?: { kind: ":" | "/"; text: string };
  private lastSearch = "";
  private pasteBuffer?: string;
  private cachedText?: string;
  private cachedWidth = -1;
  private visual: VisualLine[] = [];
  private bodyHeight = 1;
  private gutter = 0;

  constructor(readonly document: DocumentSession, private theme: () => Theme,
    private height: () => number, private redraw: () => void, private save: () => Promise<boolean> | boolean | void,
    private focus: () => void, private hide: () => void = () => {}) {}
  /** Ctrl+C: cancel the command line or leave Insert Mode. Returns false when it is not ours. */
  interrupt(): boolean {
    if (this.prompt) this.prompt = undefined;
    else if (this.document.buffer.mode === "insert") this.document.buffer.normal();
    else { this.pending = ""; return false; }
    this.redraw(); return true;
  }
  private run(kind: ":" | "/", text: string): void {
    const b = this.document.buffer;
    if (kind === "/") {
      if (text) this.lastSearch = text;
      this.find(true); return;
    }
    const command = text.trim();
    if (command === "w") void this.save();
    else if (command === "wq") void Promise.resolve(this.save()).then(ok => { if (ok) this.hide(); });
    else if (command) this.message = `Not an editor command: ${command}`;
    b.normal();
  }
  private find(forward: boolean): void {
    if (!this.lastSearch) { this.message = "No previous search"; return; }
    const result = this.document.buffer.search(this.lastSearch, forward);
    this.message = !result.found ? `Pattern not found: ${this.lastSearch}`
      : `/${this.lastSearch}${result.wrapped ? (forward ? " · wrapped to top" : " · wrapped to bottom") : ""}`;
  }
  invalidate(): void { this.cachedText = undefined; }
  private layout(width: number): void {
    const b = this.document.buffer;
    this.gutter = Math.min(String(b.lines.length).length + 1, Math.max(0, width - 3));
    const contentWidth = Math.max(1, width - this.gutter - 2);
    if (this.cachedText === b.text && this.cachedWidth === contentWidth) return;
    this.cachedText = b.text; this.cachedWidth = contentWidth; this.visual = [];
    let offset = 0;
    b.lines.forEach((line, row) => {
      let segment: VisualLine = { row, start: 0, cells: [] }, columns = 0;
      graphemes(line).forEach((g, col) => {
        let text = g === "\t" ? " ".repeat(4 - columns % 4) : safe(g);
        if (visibleWidth(text) > contentWidth) text = "�";
        const size = visibleWidth(text);
        if (columns + size > contentWidth && segment.cells.length) {
          this.visual.push(segment); segment = { row, start: col, cells: [] }; columns = 0;
        }
        segment.cells.push({ text, col, offset }); columns += size; offset += g.length;
      });
      // Reserve a cell for an end-of-line cursor, including exactly-full lines.
      if (columns >= contentWidth) { this.visual.push(segment); segment = { row, start: graphemes(line).length, cells: [] }; }
      segment.cells.push({ text: " ", col: graphemes(line).length, offset });
      this.visual.push(segment); offset++;
    });
  }
  render(width: number): string[] {
    if (width < 3) return Array.from({ length: this.height() }, () => " ".repeat(Math.max(0, width)));
    this.layout(width); this.bodyHeight = Math.max(1, this.height() - 3);
    const b = this.document.buffer, theme = this.theme();
    const cursorIndex = this.visual.findIndex(line => line.row === b.row && line.cells.some(cell => cell.col === b.col));
    if (this.followCursor && cursorIndex >= 0) {
      if (cursorIndex < this.top) this.top = cursorIndex;
      if (cursorIndex >= this.top + this.bodyHeight) this.top = cursorIndex - this.bodyHeight + 1;
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.visual.length - this.bodyHeight)));
    const range = b.selection();
    const color = this.focused ? "accent" : "muted";
    const border = (text: string) => theme.fg(color, text);
    const frame = (text: string) => {
      const fitted = truncateToWidth(text, width - 2, "");
      return border("│") + fitted + " ".repeat(Math.max(0, width - 2 - visibleWidth(fitted))) + border("│");
    };
    const title = ` ${safe(basename(this.document.path))}${this.document.dirty ? " [+]" : ""} `;
    const top = truncateToWidth(title, width - 2, "");
    const output = [border("┌" + top + "─".repeat(Math.max(0, width - 2 - visibleWidth(top))) + "┐")];
    for (let i = 0; i < this.bodyHeight; i++) {
      const line = this.visual[this.top + i];
      if (!line) { output.push(frame(theme.fg("muted", "~"))); continue; }
      const number = line.start === 0 ? String(line.row + 1).padStart(this.gutter - 1) + " " : " ".repeat(this.gutter);
      let text = theme.fg("muted", number);
      for (const cell of line.cells) {
        let displayed = cell.text;
        if (range && cell.offset >= range[0] && cell.offset < range[1]) displayed = theme.bg("selectedBg", displayed);
        if (this.focused && !this.prompt && line.row === b.row && cell.col === b.col) displayed = CURSOR_MARKER + renderFakeCursor(displayed);
        text += displayed;
      }
      output.push(frame(text));
    }
    if (this.prompt) {
      // The command line owns the IME cursor so CJK search text composes in place.
      // Keep the tail visible: that is where typing and IME composition happen.
      const room = Math.max(0, width - 3), cells = graphemes(safe(this.prompt.kind + this.prompt.text));
      let fitted = cells.join("");
      if (visibleWidth(fitted) > room) {
        const head = cells[0] + "…";
        let budget = room - visibleWidth(head), i = cells.length;
        while (i > 1 && budget >= visibleWidth(cells[i - 1])) budget -= visibleWidth(cells[--i]);
        fitted = head + cells.slice(i).join("");
      }
      fitted = truncateToWidth(fitted, room, "");
      output.push(frame(theme.fg("text", fitted) + (this.focused ? CURSOR_MARKER + renderFakeCursor(" ") : "")));
    } else {
      const status = `${b.mode.toUpperCase()} ${b.row + 1}:${b.col + 1}${this.document.conflict ? " CONFLICT" : ""} · ${this.message}`;
      output.push(frame(theme.fg(this.document.conflict ? "warning" : "muted", safe(status))));
    }
    const hint = truncateToWidth(" F6 focus ", width - 2, "");
    output.push(border("└" + hint + "─".repeat(Math.max(0, width - 2 - visibleWidth(hint))) + "┘"));
    return output;
  }
  handleInput(data: string): void {
    const b = this.document.buffer;
    // Bracketed paste may arrive split across events. It is always literal insertion.
    if (this.pasteBuffer !== undefined || data.includes("\x1b[200~")) {
      this.pasteBuffer = (this.pasteBuffer ?? "") + data;
      const end = this.pasteBuffer.indexOf("\x1b[201~");
      if (end >= 0) {
        const pasted = this.pasteBuffer.slice(0, end).replace("\x1b[200~", "");
        const remaining = this.pasteBuffer.slice(end + 6); this.pasteBuffer = undefined;
        if (this.prompt) this.prompt.text += pasted.replace(/[\x00-\x1f\x7f]/g, "");
        else b.insert(pasted.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""));
        if (remaining) this.handleInput(remaining);
      }
      this.followCursor = true; this.redraw(); return;
    }
    if (matchesKey(data, "ctrl+c")) { this.interrupt(); return; }
    this.followCursor = true;
    if (this.prompt) {
      const prompt = this.prompt;
      if (matchesKey(data, "escape")) this.prompt = undefined;
      else if (matchesKey(data, "enter")) { this.prompt = undefined; this.run(prompt.kind, prompt.text); }
      else if (matchesKey(data, "backspace")) {
        if (!prompt.text) this.prompt = undefined;
        else prompt.text = graphemes(prompt.text).slice(0, -1).join("");
      } else {
        const printable = decodeKittyPrintable(data) ?? (data && !/[\x00-\x1f\x7f]/.test(data) ? data : undefined);
        if (printable) prompt.text += printable;
      }
      this.redraw(); return;
    }
    if (matchesKey(data, "escape")) { b.normal(); this.pending = ""; }
    else if (matchesKey(data, "up")) b.move(-1, 0);
    else if (matchesKey(data, "down")) b.move(1, 0);
    else if (matchesKey(data, "left")) b.move(0, -1);
    else if (matchesKey(data, "right")) b.move(0, 1);
    else if (matchesKey(data, "home")) b.home();
    else if (matchesKey(data, "end")) b.end();
    else if (matchesKey(data, "pageUp")) b.move(-this.bodyHeight, 0);
    else if (matchesKey(data, "pageDown")) b.move(this.bodyHeight, 0);
    else if (b.mode === "insert") {
      if (matchesKey(data, "backspace")) b.backspace();
      else if (matchesKey(data, "delete")) b.deleteChar();
      else if (matchesKey(data, "enter")) b.insert("\n");
      else if (matchesKey(data, "tab")) b.insert("  ");
      else {
        const printable = decodeKittyPrintable(data) ?? (data && !/[\x00-\x1f\x7f]/.test(data) ? data : undefined);
        if (printable) b.insert(printable);
      }
    } else {
      const key = decodeKittyPrintable(data) ?? data;
      const pending = this.pending, command = pending + key; this.pending = "";
      if (command === "dd") b.yank(true);
      else if (command === "yy") b.yank();
      else if (command === "gg") { b.row = 0; b.clamp(); }
      else if (pending) { /* Unsupported operator sequence such as dw: cancel it like Vim, never run the motion alone. */ }
      else if ((key === "d" || key === "y") && b.mode !== "visual" || key === "g") this.pending = key;
      else if ((key === ":" || key === "/") && b.mode === "normal") this.prompt = { kind: key, text: "" };
      else if (key === "w" || key === "e" || key === "b") b.word(key);
      else if (key === "W" || key === "E" || key === "B") b.word(key.toLowerCase() as "w" | "e" | "b", true);
      else if (key === "n" || key === "N") this.find(key === "n");
      else if (key === "h") b.move(0, -1);
      else if (key === "j") b.move(1, 0);
      else if (key === "k") b.move(-1, 0);
      else if (key === "l") b.move(0, 1);
      else if (key === "0") b.home();
      else if (key === "$") b.end();
      else if (key === "G") { b.row = b.lines.length - 1; b.clamp(); }
      else if (key === "i") { b.normal(); b.mode = "insert"; }
      else if (key === "a") { b.move(0, 1); b.normal(); b.mode = "insert"; }
      else if (key === "A") { b.end(); b.normal(); b.mode = "insert"; }
      else if (key === "o" || key === "O") b.openLine(key === "O");
      else if (key === "v") b.toggleVisual();
      else if (key === "y") b.yank();
      else if (key === "d" && b.mode === "visual") b.yank(true);
      else if (key === "x") { if (b.mode === "visual") b.yank(true); else b.deleteChar(); }
      else if (key === "p") b.paste();
      else if (key === "u") b.undo();
      else if (matchesKey(data, "ctrl+r")) b.redo();
    }
    this.redraw();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.top += event.wheelDelta ?? 0; this.followCursor = false; this.redraw(); return { handled: true };
    }
    if (event.type === "press" && event.button === "left") {
      this.focus();
      const line = this.visual[this.top + event.y - 1];
      if (line) {
        let x = Math.max(0, event.x - 1 - this.gutter), cell = line.cells[0];
        for (const candidate of line.cells) { cell = candidate; const w = visibleWidth(candidate.text); if (x < w) break; x -= w; }
        const b = this.document.buffer; b.row = line.row; b.col = cell.col; b.clamp(); this.followCursor = true;
      }
      this.redraw(); return { handled: true };
    }
    return undefined;
  }
}
