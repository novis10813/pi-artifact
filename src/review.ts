import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
export type Decision = "approved" | "rejected" | "abandoned";
export interface ReviewResult { decision: Decision; lineComments: Map<number, string>; overallComment?: string; }

export async function openReviewUI(
  ctx: any,
  input: {
    id: string;
    title: string;
    lines: string[];
    frontmatterEnd: number;
    initialComments: Map<number, string>;
  },
): Promise<ReviewResult | undefined> {
  const factory = (
    tui: any,
    theme: any,
    _kb: any,
    done: (value: ReviewResult | undefined) => void,
  ) => {
    const minLine = input.frontmatterEnd + 1;
    let cursor = minLine;
    let scroll = 0; // index of the first visible display row (wrapped lines count separately)
    let dirty = false;
    let lastWidth = 80;

    interface DisplayEntry {
      fileLine: number;
      text: string;
    }

    function buildDisplayEntries(width: number): DisplayEntry[] {
      const entries: DisplayEntry[] = [];
      const prefixLen = 8; // "> ● 9999 "
      const contentWidth = Math.max(1, width - prefixLen);
      for (let i = input.frontmatterEnd; i < input.lines.length; i++) {
        const fileLine = i + 1;
        const content = input.lines[i] ?? "";
        const marker = fileLine === cursor ? theme.fg("accent", ">") : " ";
        const hasComment = comments.has(fileLine)
          ? theme.fg("warning", "●")
          : " ";
        const lineNo = theme.fg("dim", String(fileLine).padStart(4, " "));
        const wrapped = wrapTextWithAnsi(content, contentWidth);
        const segments = wrapped.length > 0 ? wrapped : [""];
        segments.forEach((segment, index) => {
          const prefix =
            index === 0
              ? `${marker}${hasComment} ${lineNo} `
              : " ".repeat(prefixLen);
          entries.push({ fileLine, text: prefix + segment });
        });
      }
      return entries;
    }

    function ensureCursorVisible(entries: DisplayEntry[], visible: number) {
      const idx = entries.findIndex((entry) => entry.fileLine === cursor);
      if (idx === -1) return;
      if (idx < scroll) scroll = idx;
      if (idx > scroll + visible - 1) scroll = idx - visible + 1;
      if (scroll < 0) scroll = 0;
    }
    const comments = new Map<number, string>(input.initialComments);
    let mode:
      | "view"
      | "line-comment"
      | "overall-reason"
      | "confirm-approve"
      | "confirm-quit" = "view";
    let pendingQuitDecision: Decision = "abandoned";
    const editor = new Editor(tui, {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    });

    editor.onSubmit = (value: string) => {
      if (mode === "line-comment") {
        const text = value.trim();
        const before = comments.get(cursor) || "";
        if (text) comments.set(cursor, text);
        else comments.delete(cursor);
        if (before !== text) dirty = true;
        mode = "view";
        editor.setText("");
        tui.requestRender();
        return;
      }

      if (mode === "overall-reason") {
        done({
          decision: "rejected",
          lineComments: comments,
          overallComment: value.trim() || undefined,
        });
      }
    };

    function terminalHeight(): number {
      const raw = Number(tui.terminal?.rows);
      return Number.isFinite(raw) && raw > 0 ? raw : 24;
    }

    function editorHeight(): number {
      if (mode !== "line-comment" && mode !== "overall-reason") return 0;
      return editor.render(Math.max(1, lastWidth - 2)).length;
    }

    function modeLines(): number {
      if (mode === "line-comment") return 2 + editorHeight();
      if (mode === "overall-reason") return 3 + editorHeight();
      if (mode === "confirm-approve" || mode === "confirm-quit") return 2;
      return 0;
    }

    function viewportHeight(): number {
      const region = Math.max(12, Math.floor(terminalHeight() * 0.96) - 2); // overlay box, margin 1
      const chrome = 6; // header(2) + blank + blank + current comment line + footer
      return Math.max(5, region - chrome - modeLines());
    }

    function move(delta: number) {
      cursor = Math.max(
        minLine,
        Math.min(Math.max(minLine, input.lines.length), cursor + delta),
      );
      ensureCursorVisible(buildDisplayEntries(lastWidth), viewportHeight());
      tui.requestRender();
    }

    function startLineComment() {
      mode = "line-comment";
      editor.setText(comments.get(cursor) || "");
      tui.requestRender();
    }

    function startApprove() {
      mode = "confirm-approve";
      tui.requestRender();
    }

    function startQuit(decision: Decision = "abandoned") {
      if (!dirty) {
        done({ decision, lineComments: comments });
        return;
      }
      pendingQuitDecision = decision;
      mode = "confirm-quit";
      tui.requestRender();
    }

    function startReject() {
      mode = "overall-reason";
      editor.setText("");
      tui.requestRender();
    }

    function footerHints(): string {
      const k = (key: string) => theme.fg("dim", key);
      if (mode === "line-comment")
        return `${k("enter")}: save   ${k("esc")}: cancel`;
      if (mode === "overall-reason")
        return `${k("enter")}: submit rejection   ${k("esc")}: cancel`;
      if (mode === "confirm-approve" || mode === "confirm-quit")
        return `${k("y")}: confirm   ${k("n/esc")}: cancel`;
      return `${k("j/k")}: move   ${k("g/G")}: top/bottom   ${k("c")}: comment   ${k("d")}: delete comment   ${k("a")}: approve   ${k("r")}: reject   ${k("q")}: quit`;
    }

    function render(width: number): string[] {
      const rows: string[] = [];
      const add = (line: string) => rows.push(truncateToWidth(line, width));

      const headText = ` Artifact Review: ${input.title} `;
      add(
        theme.fg("borderMuted", "─".repeat(3)) +
          theme.fg("accent", headText) +
          theme.fg(
            "borderMuted",
            "─".repeat(Math.max(0, width - 3 - headText.length)),
          ),
      );
      add(
        theme.fg(
          "dim",
          `${input.id} • line ${cursor}/${input.lines.length} • comments: ${comments.size} • ${dirty ? "unsaved changes" : "clean"}`,
        ),
      );
      add("");

      lastWidth = width;
      const entries = buildDisplayEntries(width);
      const visible = viewportHeight();
      const start = Math.max(
        0,
        Math.min(scroll, Math.max(0, entries.length - 1)),
      );
      if (entries.length === 0) {
        add(theme.fg("muted", "(empty file)"));
      } else {
        for (
          let d = start;
          d < Math.min(entries.length, start + visible);
          d++
        ) {
          add(entries[d]!.text);
        }
      }

      add("");
      const currentComment = comments.get(cursor);
      add(
        currentComment
          ? theme.fg("warning", `Line ${cursor} comment: ${currentComment}`)
          : theme.fg("muted", `Line ${cursor} comment: (none)`),
      );

      if (mode === "line-comment") {
        add("");
        add(
          theme.fg("accent", `Comment line ${cursor} (Enter save, Esc cancel)`),
        );
        for (const line of editor.render(Math.max(1, width - 2)))
          add(` ${line}`);
      }

      if (mode === "overall-reason") {
        add("");
        for (const line of wrapTextWithAnsi(
          theme.fg(
            "warning",
            "Reject reason (optional). Enter submits rejection.",
          ),
          width,
        ))
          add(line);
        for (const line of editor.render(Math.max(1, width - 2)))
          add(` ${line}`);
      }

      if (mode === "confirm-approve") {
        add("");
        add(theme.fg("success", "Approve this artifact?"));
      }

      if (mode === "confirm-quit") {
        add("");
        add(theme.fg("warning", "Unsaved changes. Quit and discard?"));
      }

      add(`  ${footerHints()}`);

      return rows;
    }

    function handleInput(data: string) {
      if (mode === "line-comment" || mode === "overall-reason") {
        if (matchesKey(data, Key.escape)) {
          mode = "view";
          editor.setText("");
          tui.requestRender();
          return;
        }
        editor.handleInput(data);
        tui.requestRender();
        return;
      }

      if (mode === "confirm-approve") {
        if (data.toLowerCase() === "y")
          return done({ decision: "approved", lineComments: comments });
        if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) {
          mode = "view";
          tui.requestRender();
        }
        return;
      }

      if (mode === "confirm-quit") {
        if (data.toLowerCase() === "y")
          return done({
            decision: pendingQuitDecision,
            lineComments: comments,
          });
        if (data.toLowerCase() === "n" || matchesKey(data, Key.escape)) {
          mode = "view";
          tui.requestRender();
        }
        return;
      }

      if (data === "j" || matchesKey(data, Key.down)) return move(1);
      if (data === "k" || matchesKey(data, Key.up)) return move(-1);
      if (data === "g") {
        cursor = minLine;
        scroll = 0;
        tui.requestRender();
        return;
      }
      if (data === "G") {
        cursor = Math.max(minLine, input.lines.length);
        ensureCursorVisible(buildDisplayEntries(lastWidth), viewportHeight());
        tui.requestRender();
        return;
      }
      if (data === "c") return startLineComment();
      if (data === "d") {
        if (comments.has(cursor)) dirty = true;
        comments.delete(cursor);
        tui.requestRender();
        return;
      }
      if (data === "a") return startApprove();
      if (data === "r") return startReject();
      if (data === "q" || matchesKey(data, Key.escape))
        return startQuit("abandoned");
    }

    return { render, handleInput, invalidate: () => {} };
  };
  return ctx.ui.custom<ReviewResult | undefined>(factory, {
    overlay: true,
    overlayOptions: { width: "80%", maxHeight: "96%", margin: 1 },
  });
}
