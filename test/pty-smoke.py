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
        os.write(master, b"\x03")
        pump(0.15)
        os.write(master, b":w\r")
        pump(0.8)
        assert plan.read_text().startswith("新增中文 # Plan"), "Right-pane editing or save failed"
        # Chat input must not modify the plan or be submitted to a model.
        os.write(master, b"\x1b[17~chat stays left")
        pump(0.5)
        assert "chat stays left" not in plan.read_text()
        # Return to the document and navigate to its end after an actual SIGWINCH.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.killpg(child.pid, signal.SIGWINCH)
        pump(0.5)
        os.write(master, b"\x1b[17~G")
        pump(0.4)
        # Clear the left chat draft and close the pane without any LLM request.
        os.write(master, b"\x1b[17~\x03")
        pump(0.4)
        command("/plan-pane close")
        # Drive the COMPLETE lifecycle with a deterministic offline model.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 180, 0, 0))
        os.killpg(child.pid, signal.SIGWINCH)
        pump(0.3)
        command("/plan on Build the tested feature")
        expect(b"PLAN review", timeout=15)
        index = json.loads((work / ".pi/artifacts/index.json").read_text())
        assert len(index["artifacts"]) == 1
        artifact = index["artifacts"][0]
        plan_path = work / artifact["path"]
        assert "Implement one verified change." in plan_path.read_text()
        assert not (work / "denied-nested.txt").exists(), "Nested tool bypassed Plan policy"
        assert "test_write" in (work / "probe.jsonl").read_text(), "Nested unsafe probe did not execute its gate"
        # User ! shell is also blocked while waiting for review.
        command("!touch forbidden-shell")
        assert not (work / "forbidden-shell").exists()
        start = len(output)
        command("/plan review")
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
        command("!touch forbidden-after-review")
        assert not (work / "forbidden-after-review").exists()
        assert not (work / "approved.txt").exists()
        start = len(output)
        command("/plan approve")
        expect(b"Approve this exact plan revision?", start=start)
        os.write(master, b"\r")
        pump(0.5)
        expect(b"PLAN approved", start=start)
        command("!touch forbidden-after-approve")
        assert not (work / "forbidden-after-approve").exists(), "Approval alone unlocked writes"
        start = len(output)
        command("/plan execute")
        expect(b"Start approved implementation?", start=start)
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
        print("PTY smoke passed: real pi split/CJK/resize, offline model updates same plan, nested+shell policy, review/approve/execute, approved write, content-change revocation, clean exit.")
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
