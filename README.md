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
/plan on Describe the change
```

This creates one durable artifact, opens it beside chat, enables planning restrictions, and asks the model to explore and revise that same document. Continue discussing in chat or edit the document with **F6**, then save with **Ctrl+S**. Model edits appear in a clean pane. Unsaved manual edits block model artifact changes rather than being overwritten.

When the model calls `request_plan_review`, its turn stops. The user then controls three separate steps:

| Command | Effect |
| --- | --- |
| `/plan review` | Open line-comment review. A positive review is not execution authorization. |
| `/plan approve` | Confirm approval of the exact saved SHA-256 revision. Tools remain restricted. |
| `/plan execute` | Confirm implementation separately, restore the pre-plan tool set, and start an implementation turn referencing that revision. |

A saved content change or unsaved draft revokes execution permission before the next intercepted tool call. Changed plans must be saved, submitted, approved, and executed again. The model cannot approve or execute a plan by writing a message or calling an artifact tool.

Other commands:

| Command | Effect |
| --- | --- |
| `/plan use <id>` | Start Plan Mode with an existing artifact. |
| `/plan status` | Show current phase, artifact identity, and revision. |
| `/plan show` | Open the active plan. |
| `/plan revise` | Return to planning and revoke approval. |
| `/plan done` | End implementation and restrict tools again. |
| `/plan off` | Explicitly leave Plan Mode and remove its restrictions, without granting approval. |

An active plan must be turned off before switching to another one. State changes require an idle agent and no unsaved document or document I/O. Approval and execution require interactive confirmation dialogs.

### Tool policy and limits

During planning, known read/search/web/question tools, artifact tools, task bookkeeping, verification registration, and context-management tools are allowed. Project write/edit, shell, arbitrary code wrappers (`codemode`), workflow/subagent delegation, background jobs, and unknown tools are denied. While waiting for review, the allowed set narrows to document reading and context management.

The package filters the visible tool set and checks `tool_call`, including nested `ctx.executeTool` calls. Interactive `!` shell commands are also checked. Execution restores only the tool set that was available before planning.

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

The selector includes previously approved artifacts. Review supports `j/k`, arrows, `g/G`, `c` to add/edit a line comment, `d` to delete it, `a` then `y` to approve the document, `r` to submit a rejection reason, and `q` or Esc to cancel. Review results sent to the model explicitly state `executionApproved: false`.

Project-local persistence:

```text
.pi/artifacts/index.json
.pi/artifacts/content/...
.pi/artifacts/revisions/<artifact-id>/<sha256>.md
.pi/artifacts/reviews/<artifact-id>.<sha256>.review.json
.pi/artifacts/reviews/<artifact-id>.review.json
```

IDs remain stable while content revisions change. Legacy indexes and nested content layouts are read additively without deleting or moving files. Existing content receives revision snapshots when read. Old unversioned approval is never trusted for execution. Comments are restored automatically only for their exact revision, so legacy unversioned comments remain on disk but are not silently applied to potentially changed lines.

Plan state is stored as pi session custom entries and reconstructed from the active branch. Switching branches does not overwrite the working document with an older snapshot. Reloading or restoring an executing state downgrades it to approved, requiring another explicit `/plan execute`. Corrupt state or unreadable content fails closed. Historical revisions can be read with `read_artifact`; this package does not restore arbitrary project files.

## Split editor

Open an existing Markdown file independently of Plan Mode:

```text
/plan-pane open docs/plan.md
```

Paths are relative to pi's working directory. Spaces need no surrounding quotes. The canonical target must be an existing `.md` regular file of at most 1 MiB. Symlinks are resolved when opening.

The document opens with chat still active. **F6** switches keyboard input between chat and the document. Clicking either editor also changes its input target. The right pane shows Markdown source, not a rendered preview.

| Mode | Keys | Action |
| --- | --- | --- |
| Any document mode | F6 | Return to chat or switch back to the document |
| Any document mode | Ctrl+S | Save after checking the disk baseline |
| Normal | `i`, `a`, `A` | Insert at cursor, after cursor, or end of line |
| Insert / visual | Esc | Return to normal mode |
| Normal / visual | `hjkl`, arrows | Move cursor by grapheme / logical line |
| Normal / visual | `0`, `$`, Home, End | Start / end of logical line |
| Normal / visual | `gg`, `G`, PageUp, PageDown | Navigate the document |
| Normal | `o`, `O` | Open a line below / above and enter insert mode |
| Normal | `x`, `dd`, `yy`, `p` | Delete character, delete line, yank line, paste |
| Normal | `v` | Start an inclusive visual selection |
| Visual | `y`, `d`, `x` | Yank or delete the selection |
| Normal | `u`, Ctrl+R | Undo / redo |
| Insert | Enter, Backspace, Delete, Tab | Edit text; Tab inserts two spaces |

Bracketed paste inserts literal text in either mode. Yank/paste uses an internal register, not the system clipboard. Use your terminal's paste shortcut for clipboard text. Ctrl+S retains pi's original meaning when chat has focus.

This is a small Vim-inspired editor, not embedded Neovim. It does not load Neovim settings, plugins, macros, Ex commands, or motions beyond those listed. Esc belongs to document editing while the right pane is active. Return to chat with F6 before using pi's Esc-to-interrupt behavior. Application clear, exit, and suspend shortcuts remain routed to pi.

### Conflicts and recovery

```text
/plan-pane show
/plan-pane save
/plan-pane copy docs/plan-conflict-copy.md
/plan-pane close
/plan-pane discard
```

`show` reattaches a retained document and focuses an attached pane. `save` checks the exact disk baseline and refuses to overwrite an external change. Saves serialize through pi's `withFileMutationQueue`, use an adjacent temporary file and rename, and preserve file mode and CRLF line endings. These checks are not cross-process atomic compare-and-swap.

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

Widths remain equal on resize, with one extra column on the left for odd widths. There is no automatic narrow-terminal fallback. Close the pane to restore full-width chat when space is insufficient.

## Verification

Requires Node.js, an installed pi, and Python 3 for the PTY test:

```bash
npm test
npm run test:pty
```

No `npm install` is needed for the local tests. They resolve host dependencies from installed pi. Set `PI_PACKAGE_ROOT` if pi is installed outside the managed release location or active Node global prefix.

The unit/integration suite covers storage, revision approval, fail-closed policy, active-branch restore, review UI, editor behavior, real pi layout rendering, and its stable renderer proxy.

The PTY test starts real pi with an isolated agent directory, offline mode, no discovered extensions or MCP, and no copied credentials. A test-only in-process provider makes scripted model/tool calls without a network transport. It exercises CJK paste/save, focus and resize, one-plan model updates, nested and shell blocking, persisted review comments, separate approval/execution dialogs, an authorized write, content-change revocation, and clean exit. Exact half-width geometry is asserted by the layout integration test.

Automated tests check CJK graphemes and the IME cursor marker. **Visual acceptance of an actual Chinese input-method candidate window still requires an interactive terminal check.**
