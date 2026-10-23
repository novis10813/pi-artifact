#!/usr/bin/env python3
"""Real-pi split editor and Plan lifecycle. Offline scripted provider, isolated files."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
pi = shutil.which("pi")
if not pi:
    raise SystemExit("pi executable required for PTY smoke")

with tempfile.TemporaryDirectory(prefix="pi-artifact-pty-") as directory:
    work = Path(directory)
    agent = work / "agent"
    agent.mkdir()
    (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "theme": "dark", "tuiMode": "fullscreen"}))
    plan = work / "plan.md"
    plan.write_text("# Plan\n原始計畫\n" + "long plan line\n" * 150)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 160, 0, 0))
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color", "PI_TUI_WRITE_LOG": str(work / "ansi.log")}
    # The test provider runs in-process with no HTTP transport or live credentials.
    child = subprocess.Popen([pi, "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "--no-session", "--offline", "--no-approve", "--tui-mode", "fullscreen", "--use-theme", "dark", "--provider", "plan-test", "--model", "scripted", "-e", str(ROOT / "test/mock-provider.ts"), "-e", str(ROOT / "src/extension.ts")],
                             cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def pump(seconds=0.3):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output.extend(chunk)
            # Minimal terminal query replies. Never interpreted as user input.
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b[c" in chunk:
                os.write(master, b"\x1b[?1;2c")

    def expect(needle, timeout=12, start=0):
        deadline = time.monotonic() + timeout
        while needle not in output[start:] and time.monotonic() < deadline and child.poll() is None:
            pump(min(0.3, max(0, deadline - time.monotonic())))
        if needle not in output[start:]:
            probe = (work / "probe.jsonl").read_text() if (work / "probe.jsonl").exists() else "(no probe)"
            raise AssertionError(f"Missing {needle!r}. Exit={child.poll()} probe={probe} tail={bytes(output[-5000:])!r}")

    def command(text):
        os.write(master, b"\x1b[200~" + text.encode() + b"\x1b[201~")
        pump()
        os.write(master, b"\r")
        pump(0.7)

    try:
        expect(b"\x1b[?1049h")
        pump(2)
        command("/plan-pane open plan.md")
        expect(b"plan.md")
        expect(b"F6 focus")
        # Switch to document, insert literal CJK and paste content, Ctrl+C to normal mode, :w.
        os.write(master, b"\x1b[17~")
        os.write(master, b"i")
        os.write(master, b"\x1b[200~" + "新增中文 ".encode() + b"\x1b[201~")
        start = len(output)
        os.write(master, b"\x03")
        expect(b"NORMAL", start=start)
        os.write(master, b":w\r")
        pump(0.8)
        assert plan.read_text().startswith("新增中文 # Plan"), "Right-pane editing or save failed"
        saved = plan.read_text()
        # Real shortcut dispatch: search, wrapping, cancellation and both word-motion sets.
        start = len(output)
        os.write(master, "/原始\r".encode())
        expect(b"NORMAL 2:1", start=start)
        start = len(output)
        os.write(master, b"n")
        expect(b"wrapped to top", start=start)
        start = len(output)
        os.write(master, b"N")
        expect(b"wrapped to bottom", start=start)
        start = len(output)
        os.write(master, b"/absent-pattern\r")
        expect(b"Pattern not found: absent-pattern", start=start)
        os.write(master, b"/cancelled\x03")
        pump(0.2)
        start = len(output)
        os.write(master, b"/long\r")
        expect(b"NORMAL 3:1", start=start)
        for key, position in [(b"w", b"3:6"), (b"e", b"3:9"), (b"b", b"3:6"),
                              (b"W", b"3:11"), (b"E", b"3:14"), (b"B", b"3:11")]:
            start = len(output)
            os.write(master, key)
            expect(b"NORMAL " + position, start=start)
        start = len(output)
        os.write(master, b"v")
        expect(b"VISUAL 3:11", start=start)
        start = len(output)
        os.write(master, b"b")
        expect(b"VISUAL 3:6", start=start)
        os.write(master, b"\x1b")
        pump(0.2)
        assert plan.read_text() == saved, "Search or word motions changed the saved document"
        # F7 from the focused document hides the pane through pi's shortcut dispatch; F7 from chat reshows it.
        start = len(output)
        os.write(master, b"\x1b[18~")
        expect(b"Plan pane hidden", start=start)
        start = len(output)
        os.write(master, b"\x1b[18~")
        expect(b"F7 hide", start=start)
        # Reshown with chat focus. Chat input must not modify the plan or be submitted to a model.
        os.write(master, b"chat stays left")
        pump(0.5)
        assert "chat stays left" not in plan.read_text()
        # Return to the document and navigate to its end after an actual SIGWINCH.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.killpg(child.pid, signal.SIGWINCH)
        pump(0.5)
        os.write(master, b"\x1b[17~G")
        pump(0.4)
        # Clear the left chat draft without any LLM request.
        os.write(master, b"\x1b[17~\x03")
        pump(0.4)
        # :wq persists the current draft and hides, without closing pi or losing the document.
        os.write(master, b"\x1b[17~A")
        os.write(master, b"\x1b[200~ wq-saved\x1b[201~\x03")
        pump(0.2)
        start = len(output)
        os.write(master, b":wq\r")
        expect(b"Plan pane hidden", start=start)
        assert "wq-saved" in plan.read_text(), ":wq hid before saving the document"
        command("/plan-pane close")
        # Drive the COMPLETE lifecycle with a deterministic offline model.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 180, 0, 0))
        os.killpg(child.pid, signal.SIGWINCH)
        pump(0.3)
        start = len(output)
        command("/plan")
        expect(b"PLAN planning", start=start)
        assert not (work / "probe.jsonl").exists(), "/plan must not call the model"
        initial_index = json.loads((work / ".pi/artifacts/index.json").read_text())
        initial_path = work / initial_index["artifacts"][0]["path"]
        assert initial_path.read_text().startswith("# <Feature name> Spec\n")
        command("Build the tested feature")
        expect(b"PLAN review", timeout=15, start=start)
        index = json.loads((work / ".pi/artifacts/index.json").read_text())
        assert len(index["artifacts"]) == 1
        artifact = index["artifacts"][0]
        plan_path = work / artifact["path"]
        assert "Implement one verified change." in plan_path.read_text()
        assert not (work / "denied-nested.txt").exists(), "Nested tool bypassed Plan policy"
        assert "test_write" in (work / "probe.jsonl").read_text(), "Nested unsafe probe did not execute its gate"
        # Hide from chat focus, then explicitly /plan show the same retained document.
        start = len(output)
        os.write(master, b"\x1b[18~")
        expect(b"Plan pane hidden", start=start)
        start = len(output)
        command("/plan show")
        expect(b"F7 hide", start=start)
        expect(b"PLAN review", start=start)
        # Repeated show on the mounted pane must keep chat focus, not redirect pasted commands.
        command("/plan show")
        start = len(output)
        command("!touch forbidden-shell")
        expect(b"blocks bash", start=start)
        assert not (work / "forbidden-shell").exists()
        # Closed -> show follows the same focus contract as hidden -> show.
        command("/plan-pane close")
        command("/plan show")
        start = len(output)
        command("!touch forbidden-after-show")
        expect(b"blocks bash", start=start)
        assert not (work / "forbidden-after-show").exists()
        snapshot = work / ".pi/artifacts/revisions" / artifact["id"] / (artifact["revision"] + ".md")
        assert plan_path.read_text() == snapshot.read_text(), "Show or chat commands changed the document"
        start = len(output)
        command("/plan review")
        expect(b"Subagent review complete.", start=start)
        probes = [json.loads(line) for line in (work / "probe.jsonl").read_text().splitlines()]
        dispatch = next(p["reviewDispatch"] for p in probes if "reviewDispatch" in p)
        assert dispatch["agent"] == "logic-reviewer"
        assert "revisions" in dispatch["task"] and "exact revision" in dispatch["task"]
        assert not (work / "approved.txt").exists(), "Subagent PASS unlocked implementation"
        assert b"Artifact Review" not in output[start:], "/plan review must not open the manual line-review UI"
        # Legacy /artifact line review remains available and stores comments.
        start = len(output)
        command(f"/artifact review {artifact['id']}")
        expect(b"Artifact Review", start=start)
        os.write(master, b"c")
        pump(0.2)
        os.write(master, b"\x1b[200~Verify the exact revision.\x1b[201~\r")
        pump(0.3)
        os.write(master, b"ay")
        pump(0.8)
        saved_review = json.loads((work / f".pi/artifacts/reviews/{artifact['id']}.review.json").read_text())
        assert saved_review["lineComments"][0]["comment"] == "Verify the exact revision."
        # A generic positive review still must not unlock implementation.
        start = len(output)
        command("!touch forbidden-after-review")
        expect(b"blocks bash", start=start)
        assert not (work / "forbidden-after-review").exists()
        assert not (work / "approved.txt").exists()
        start = len(output)
        command("/plan execute")
        expect("已移除".encode(), start=start)
        start = len(output)
        command("/plan approve")
        expect("核准並開始實作".encode(), start=start)
        os.write(master, b"\r")
        pump(1)
        expect(b"Implementation complete.", start=start)
        assert (work / "approved.txt").read_text() == "approved implementation\n"
        # The approved content changed: the next user shell must be locked again.
        plan_path.write_text(plan_path.read_text() + "\nchanged after execution\n")
        command("!touch forbidden-after-change")
        assert not (work / "forbidden-after-change").exists()
        expect(b"PLAN planning", start=start)
        command("/plan-pane close")
        os.write(master, b"\x04")
        pump(1)
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=8)
        assert child.returncode == 0, f"Unexpected pi exit: {child.returncode}"
        assert b"Failed to load extension" not in output
        print("PTY smoke passed: real pi split/CJK/Ctrl+C/:w/:wq/F7/search/word motions/resize, offline model updates same plan, main-session nested+shell policy, subagent review dispatch, one-step approve+execute, legacy line review, approved write, content-change revocation, clean exit.")
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
