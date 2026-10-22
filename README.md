# pi-artifact

Revision-bound Plan Mode and a fullscreen split artifact editor for [pi](https://github.com/earendil-works/pi). The original chat stays on the left, and an editable Markdown document occupies the right half. Saving or reviewing a document never authorizes implementation.

## Install

```bash
pi install git:github.com/novis10813/pi-artifact
```

Restart pi or run `/reload`. Use fullscreen mode (`pi --tui-mode fullscreen`). For a temporary checkout without changing settings:

```bash
pi --tui-mode fullscreen -e ./src/extension.ts
```

If migrating from an older standalone `artifact.ts`, remove that extension from pi's auto-discovery directory before loading this package. Do not load both implementations. Leave project `.pi/artifacts/` directories intact.

## Plan workflow

```text
/plan Describe the change
```

This creates one durable artifact from a spec template (goal and boundaries, context, requirements, work units, execution layers and boundaries), opens it beside chat, enables planning restrictions, and asks the model to explore and revise that same document. Continue discussing in chat or switch to the document with **F6**, edit, return to Normal Mode with Esc or Ctrl+C, and save with **`:w`**. Model edits appear in a clean pane. Unsaved manual edits block model artifact changes rather than being overwritten.

When the model calls `request_plan_review`, its turn stops, but later questions, exploration and revisions remain available. Review is optional:

| Command | Effect |
| --- | --- |
| `/plan review` | Ask the main model to call a foreground subagent to review the exact revision and summarize findings in chat. No manual review window. A positive result never authorizes execution. |
| `/plan approve` | One confirmation approves the exact saved SHA-256 revision **and starts implementation immediately**, restoring the pre-plan tool set. The dialog explains the opening of main-agent writes, shell and workflow delegation. The main model is then asked to run the plan as one background pi-dynamic-workflows run: one worktree per work unit, checked repair with spec and code reviewers, committed work before every check, merges into an integration branch `plan/<rev>`, and a final report. It does not merge into your branch. |

Approval checks the revision and unsaved draft before and after confirmation. Canceling, a changed revision or an unsaved draft leaves execution locked. Review does not need to complete before approval. The main model is instructed to compare the current revision after a subagent returns and mark old findings stale if it changed; this is not a stored review-pass gate.

A saved content change or unsaved draft revokes execution permission before the next intercepted main-session tool call. Save the revised plan and use `/plan approve` again. The model cannot grant execution by writing a message, calling artifact tools or receiving a positive subagent review. The old `/plan on` and `/plan execute` commands are removed and report the replacement usage, not aliases.

Other commands:

| Command | Effect |
| --- | --- |
| `/plan use <id>` | Start Plan Mode with an existing artifact. |
| `/plan` or `/plan status` | Show phase, identity, revision, usage and unavailable reasons. A bare `/plan` creates or executes nothing. |
| `/plan show` | Open the active plan. |
| `/plan revise` | Return to planning and revoke approval. |
| `/plan done` | End implementation and block main-agent writes, shell and new subagent calls again. Edits do not reopen a finished plan; use `/plan revise`. |
| `/plan off` | Explicitly leave Plan Mode and remove its restrictions, without granting approval. |

An active plan must be turned off before switching to another one. State changes require an idle agent and no unsaved document or document I/O. Approval requires an interactive confirmation dialog.

Type `/plan ` for subcommands and descriptions, filtered by prefix, with unavailable reasons for the current phase. Reserved bare words are commands. Other text is a goal, including `review the auth module`. `use <id>` selects an existing artifact, and the removed `on` prefix reports an error. Phases are `planning`, `review`, `executing` and `done`, shown in the pane's bottom-right corner, not the global footer.

### Tool policy and limits

During planning and review, known read/search/web/question tools, artifact tools, task bookkeeping and context-management tools are allowed. The main model may call `subagent`, `list_subagents` and `subagent_status` directly if enabled before planning. Main-agent project write/edit, shell, arbitrary code wrappers (`codemode`), workflows, background-process tools and unknown tools remain denied. Questions and revisions are not frozen in review; edits return it to planning.

**Subagent permissions are not restricted by Plan Mode.** Child tool sets and nested delegation are owned by the installed subagent extension and agent definitions. Asking a child not to write or run shells is an instruction, not enforcement. This version deliberately allows direct subagent calls without a read-only guarantee. `/plan review` requires an enabled subagent tool and asks the main agent to call five plan reviewers one by one: `logic-reviewer`, `system-reviewer`, `scope-reviewer`, `execution-reviewer` and `verification-reviewer`. Their definitions are not part of this package; install them in the subagent agents directory. Results are reported per lane, failed lanes are listed without retry, and all lanes are marked stale if the revision changed. If the subagent tool is unavailable, it reports the problem; you can still approve without review.

The package filters the visible tool set and checks main-session `tool_call` events, including nested `ctx.executeTool` calls in that session. Interactive `!` shell commands are also checked. Execution restores only the tool set that was available before planning. These checks do not propagate into subagent child sessions.

This is session-level tool policy, **not an OS sandbox**. It trusts the behavior of allowlisted tools and other extensions. It does not stop already-running processes, control other pi sessions, or retroactively restrict work delegated before entering Plan Mode. Explicit `/plan off` intentionally removes the policy.

## Artifacts, revisions, and review

The model-facing tools are:

| Tool | Purpose |
| --- | --- |
| `create_artifact({content, title?})` | Create a reviewable artifact. In active Plan Mode, replace and submit the same plan rather than creating duplicates. |
| `edit_artifact({artifactId, edits})` | Apply unique, non-overlapping exact text replacements against the original content. |
| `read_artifact({artifactId, revision?})` | Read current content or an immutable revision. |
| `replace_artifact({artifactId, content, expectedRevision})` | Replace content only if the expected revision still matches. |
| `request_plan_review({})` | Submit the active plan and stop the turn. |

Historical `create_artifact` and `edit_artifact` argument shapes and result details are retained. Generic artifact creation stops for user review in interactive sessions. It does not enter or approve Plan Mode automatically.

```text
/artifact
/artifact <id-or-path>
/artifact review <id-or-path>
/artifact abandon <id-or-path>
```

The selector includes previously approved artifacts. This legacy line-comment review is separate from `/plan review`, does not change Plan Mode phase or authorization, and retains existing comment data. Review supports `j/k`, arrows, `g/G`, `c` to add/edit a line comment, `d` to delete it, `a` then `y` to approve the document, `r` to submit a rejection reason, and `q` or Esc to cancel. Review results sent to the model explicitly state `executionApproved: false`.

Project-local persistence:

```text
.pi/artifacts/index.json
.pi/artifacts/content/...
.pi/artifacts/revisions/<artifact-id>/<sha256>.md
.pi/artifacts/reviews/<artifact-id>.<sha256>.review.json
.pi/artifacts/reviews/<artifact-id>.review.json
```

IDs remain stable while content revisions change. Legacy indexes and nested content layouts are read additively without deleting or moving files. Existing content receives revision snapshots when read. Old unversioned approval is never trusted for execution. Comments are restored automatically only for their exact revision, so legacy unversioned comments remain on disk but are not silently applied to potentially changed lines.

Plan state is stored as pi session custom entries and reconstructed from the active branch. Switching branches does not overwrite the working document with an older snapshot. Reloading or restoring an executing state, including legacy persisted `approved`, returns it to review with no execution grant. A fresh `/plan approve` confirmation is required. Corrupt state or unreadable content fails closed. `read_artifact` includes the revision in model-visible text and can read immutable historical snapshots; this package does not restore arbitrary project files.

## Split editor

Open an existing Markdown file independently of Plan Mode:

```text
/plan-pane open docs/plan.md
```

Paths are relative to pi's working directory. Spaces need no surrounding quotes. The canonical target must be an existing `.md` regular file of at most 1 MiB. Symlinks are resolved when opening.

The document opens with chat still active. **F6** switches keyboard input between chat and the document. Clicking either editor also changes its input target. **F7** or `/plan-pane toggle` hides or reshows the pane. Hidden chat uses full width; reshow restores equal columns. The document, unsaved text and cursor position are retained without saving. Pane-local scroll, search history and pending commands reset on reshow. Hiding neither exits Plan Mode nor grants execution. F7 is global and reports an error when no document is open.

The right pane shows Markdown source, not a rendered preview. Its mode and cursor position stay visible; `[+]` marks unsaved text. The bottom border shows F6/F7 hints on the left and the Plan phase on the right. Narrow panes drop the hints before the phase.

| Mode | Keys | Action |
| --- | --- | --- |
| Any document mode | F6 | Return to chat or switch back to the document |
| Anywhere | F7 | Hide / reshow the retained document |
| Normal | `:w`, Enter | Save after checking the disk baseline |
| Normal | `:wq`, Enter | Save, then hide only on success; return to full-width chat |
| Normal | `i`, `a`, `A` | Insert at cursor, after cursor, or end of line |
| Insert | Esc, Ctrl+C | Return to Normal Mode without clearing text or interrupting pi |
| Visual | Esc | Return to Normal Mode |
| Normal / visual | `hjkl`, arrows | Move cursor by grapheme / logical line |
| Normal / visual | `0`, `$`, Home, End | Start / end of logical line |
| Normal / visual | `gg`, `G`, PageUp, PageDown | Navigate the document |
| Normal / visual | `w`, `e`, `b` | Next word start, current / next word end, previous word start; punctuation is separate |
| Normal / visual | `W`, `E`, `B` | The same motions with whitespace-separated WORDs |
| Normal | `/text`, Enter; `n`, `N` | Search forward, repeat next / previous match |
| Normal | `o`, `O` | Open a line below / above and enter insert mode |
| Normal | `x`, `dd`, `yy`, `p` | Delete character, delete line, yank line, paste |
| Normal | `v` | Start an inclusive visual selection |
| Visual | `y`, `d`, `x` | Yank or delete the selection |
| Normal | `u`, Ctrl+R | Undo / redo |
| Insert | Enter, Backspace, Delete, Tab | Edit text; Tab inserts two spaces |

Search is case-sensitive plain text, supports Chinese and wraps around the document. The status shows the search text, wrapping or a missing-pattern message. It does not alter content or dirty state. Esc or Ctrl+C cancels search or command input and keeps the document cursor unchanged; Backspace edits the prompt. Word motions cross lines and blank lines without splitting graphemes, including combining characters and emoji. In Visual Mode, they extend the selection.

Bracketed paste inserts literal text, or prompt text while a command/search is active. Yank/paste uses an internal register, not the system clipboard. Use your terminal's paste shortcut for clipboard text. The document has no Ctrl+S save binding; chat retains pi's original Ctrl+S behavior.

This is a small Vim-inspired editor, not embedded Neovim. Only `:w` and `:wq` are supported Ex commands. Unknown commands report an error without changing text. There is no regex search, replace, count prefix, `dw`/`cw` operator combination, shell escape, or arbitrary-path save. It does not load Neovim settings, plugins or macros. Esc belongs to document editing while the right pane is active. Return to chat with F6 before using pi's Esc-to-interrupt behavior. Ctrl+C first cancels a prompt, leaves Insert Mode, or cancels a pending operator; otherwise pi keeps its original handling.

### Conflicts and recovery

```text
/plan-pane show
/plan-pane toggle
/plan-pane save
/plan-pane copy docs/plan-conflict-copy.md
/plan-pane close
/plan-pane discard
```

`show` reattaches a retained document and focuses an attached pane. `toggle` hides or reshows it without saving or closing the document. `save` and `:w` check the exact disk baseline and refuse to overwrite an external change. `:wq` leaves the pane open with the draft intact on conflict or failure. Saves serialize through pi's `withFileMutationQueue`, use an adjacent temporary file and rename, and preserve file mode and CRLF line endings. These checks are not cross-process atomic compare-and-swap.

`copy` writes the draft to a new path and never overwrites an existing file or clears the original dirty state. `close` refuses to abandon unsaved work. `discard` explicitly drops the draft. A clean document follows disk changes every 500 ms. A dirty draft remains in memory with a conflict indicator. Resolve conflicts by saving a copy, discarding the original buffer, and reopening the intended document. There is no force-overwrite command.

Outside Plan Mode, normal file tools are not intercepted to protect editor drafts. Inside Plan Mode, artifact changes also check for a dirty pane. Session switches, forks, and tree navigation are refused while a draft is dirty or document I/O is active.

A graceful `/reload` or shutdown writes unsaved text to a private recovery file:

```text
<pi-agent-dir>/drafts/pi-artifact/<timestamp>-<uuid>-<original-name>.md
```

The default agent directory is `~/.pi/agent`. Directories use mode `0700` and recovery files `0600`. The path is reported in pi. Recoveries are not automatically reopened. Use `/plan-pane open <path>` to inspect one. Crashes, SIGKILL, and power loss are not protected by this shutdown-only recovery.

## Compatibility

Tested with pi 1.3.0 (`@earendil-works` packages). Fullscreen mode is required for the split UI. Regular, print, JSON, and RPC modes do not provide it. Plan policy does not depend on split UI support, but approval and execution require interactive dialogs.

The adapter uses public `HStack`, `CustomEditor`, `setEditorComponent`, and `ViewportTUI.setLayoutRoot` APIs. Reading the existing `layoutRoot` is a guarded **private API dependency**, isolated in `src/split.ts`, because this pi version has no public root getter.

The complete original chat root is retained, including transcript and footer. The adapter refuses to replace another extension's editor factory and restores layout/editor slots only while it owns them. A competing layout change or renderer swap detaches the pane while retaining the draft. The package uses status entries and never replaces the footer.

Widths remain equal on resize, with one extra column on the left for odd widths. There is no automatic narrow-terminal fallback. Hide the pane with F7 to restore full-width chat when space is insufficient.

## Verification

Requires Node.js, an installed pi, and Python 3 for the PTY test:

```bash
npm test
npm run test:pty
```

No `npm install` is needed for the local tests. They resolve host dependencies from installed pi. Set `PI_PACKAGE_ROOT` if pi is installed outside the managed release location or active Node global prefix.

The unit/integration suite covers storage, revision approval, fail-closed policy, active-branch restore, review UI, editor behavior, real pi layout rendering, and its stable renderer proxy.

The PTY test starts real pi with an isolated agent directory, offline mode, no discovered extensions or MCP, and no copied credentials. A test-only in-process provider makes scripted model/tool calls without a network transport. It exercises CJK paste/save, Ctrl+C, F7, `:wq`, search and word motions, focus and resize, one-plan model updates, main-session nested and shell blocking, subagent review dispatch, persisted legacy line comments, one approve-and-execute dialog, an authorized write, content-change revocation, and clean exit. The subagent is a dispatch stub, not a real child-process or read-only enforcement test. Exact half-width geometry is asserted by the layout integration test.

Automated tests check CJK graphemes and the IME cursor marker. **Visual acceptance of an actual Chinese input-method candidate window still requires an interactive terminal check.**
