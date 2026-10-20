import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
import { HStack, isViewportTUI, matchesKey, type Component, type TUI, type ViewportTUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DocumentSession } from "./document.ts";
import { DocumentPane } from "./pane.ts";

// Compatibility boundary: pi 1.3.0 has a public setter, but no root getter.
// Keep this single guarded private read separate from document/editor behavior.
function currentRoot(tui: TUI): Component | undefined {
  const value = (tui as TUI & { layoutRoot?: Component }).layoutRoot;
  return value && typeof value.render === "function" && typeof value.invalidate === "function" ? value : undefined;
}

// pi 1.3.0's grow allocator distributes remaining space sequentially, so equal
// grow weights are not a true half split. Bind explicit bases to terminal width.
class EqualSplit extends HStack {
  constructor(left: Component, right: Component, columns: () => number) {
    super([{ component: left, basis: 0, grow: 0, shrink: 0 }, { component: right, basis: 0, grow: 0, shrink: 0 }]);
    Object.defineProperty(this.entries[0], "basis", { get: () => Math.ceil(columns() / 2) });
    Object.defineProperty(this.entries[1], "basis", { get: () => Math.floor(columns() / 2) });
  }
}

/** Owns only its editor factory and root slot. Never replaces another extension's slots. */
export class SplitView {
  private tui?: ViewportTUI;
  private original?: Component;
  private root?: Component;
  private editor?: CustomEditor;
  private right = false;
  private pane?: DocumentPane;
  readonly factory: EditorFactory;

  constructor(private ctx: ExtensionContext, readonly document: DocumentSession, save: () => void) {
    const owner = this;
    this.factory = (surface, theme, keys) => {
      if (!isViewportTUI(surface)) throw new Error("Plan pane requires fullscreen mode.");
      const original = currentRoot(surface);
      if (!original) throw new Error("This pi version does not expose a compatible fullscreen root.");
      this.tui = surface; this.original = original;
      this.pane = new DocumentPane(document, () => this.ctx.ui.theme,
        () => Math.max(4, surface.terminal.rows), () => surface.requestRender(), save, () => this.focusPlan());
      this.editor = new class extends CustomEditor {
        handleInput(data: string): void {
          if (matchesKey(data, "f6")) { owner.right = !owner.right; surface.requestRender(); return; }
          if (owner.right) {
            // App clear/exit/suspend still work. Esc belongs to document modal editing.
            if (keys.matches(data, "app.clear") || keys.matches(data, "app.exit") || keys.matches(data, "app.suspend")) super.handleInput(data);
            else owner.pane!.handleInput(data);
          } else super.handleInput(data);
        }
        handleMouse(event: TuiMouseEvent) {
          if ((event.type === "press" || event.type === "click") && event.button === "left" && owner.right) {
            owner.right = false; surface.requestRender();
          }
          return super.handleMouse(event);
        }
        render(width: number): string[] {
          const focused = this.focused;
          // Only the active pane emits the IME cursor marker. Keep host focus on
          // the composer bridge so host focus restoration cannot steal plan focus.
          if (owner.right) this.focused = false;
          try { return super.render(width); }
          finally { this.focused = focused; }
        }
      }(surface, theme, keys);
      const pane = this.pane;
      const rightPanel: Component = {
        render: width => { pane.focused = this.right && !!this.editor?.focused; return pane.render(width); },
        invalidate: () => pane.invalidate(),
        handleMouse: event => pane.handleMouse(event),
      };
      this.root = new EqualSplit(original, rightPanel, () => surface.terminal.columns);
      surface.setLayoutRoot(this.root);
      return this.editor;
    };
  }
  mount(): void {
    if (this.ctx.ui.getEditorComponent()) throw new Error("Another extension owns the chat editor. Plan pane was not opened.");
    try { this.ctx.ui.setEditorComponent(this.factory); }
    catch (error) { this.unmount(); throw error; }
  }
  get attached(): boolean {
    return !!this.tui && isViewportTUI(this.tui) && this.ctx.ui.getEditorComponent() === this.factory && currentRoot(this.tui) === this.root;
  }
  focusPlan(): void {
    // Inline host selectors are not overlays. They clear the bridge's focused
    // flag, so never take focus from them (or from any other active dialog).
    if (!this.attached || !this.editor?.focused || this.tui!.hasOverlay()) return;
    this.right = true; this.tui!.setFocus(this.editor!); this.tui!.requestRender();
  }
  message(text: string): void {
    if (this.pane) { this.pane.message = text; this.tui?.requestRender(); }
  }
  unmount(): void {
    if (this.tui && isViewportTUI(this.tui) && currentRoot(this.tui) === this.root) this.tui.setLayoutRoot(this.original);
    if (this.ctx.ui.getEditorComponent() === this.factory) this.ctx.ui.setEditorComponent(undefined);
    this.root = undefined; this.tui = undefined; this.editor = undefined; this.pane = undefined;
  }
}
