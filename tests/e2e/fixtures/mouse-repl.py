#!/usr/bin/env python3
"""Mouse-reporting REPL fixture for the app-mouse e2e test.

Models an agent TUI (e.g. Claude Code, Codex) that owns the mouse:
  - enables SGR mouse reporting (ESC[?1000h ?1002h ?1006h) once at startup
    and never re-emits it, so a browser xterm attaching later only learns
    the mode via agentboard's tmux-copy-mode-status ENABLE_MOUSE_TRACKING
    write;
  - echoes every SGR mouse sequence it receives as an escaped, single-line
    MOUSESEQ marker so tests can assert via `tmux capture-pane` that real
    drags forwarded into the pane.

Usage: mouse-repl.py [NAME]  (NAME is only shown in the READY banner)
"""
import os
import select
import sys
import termios
import tty

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
ESC = b"\x1b"


def main() -> None:
    tty.setraw(fd)
    name = sys.argv[1].encode() if len(sys.argv) > 1 else b"?"
    os.write(1, b"\x1b[?1000h\x1b[?1002h\x1b[?1006h")
    os.write(1, b"MOUSE-REPL READY " + name + b"\r\n")
    buf = b""
    try:
        while True:
            readable, _, _ = select.select([fd], [], [], 0.05)
            if not readable:
                continue
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            buf += chunk
            # Emit one marker per complete SGR mouse report (ESC[<b;x;y M|m).
            while True:
                i = buf.find(b"\x1b[<")
                if i == -1:
                    if len(buf) > 64:
                        buf = buf[-8:]
                    break
                m_end = buf.find(b"M", i)
                rel_end = buf.find(b"m", i)
                ends = [x for x in (m_end, rel_end) if x != -1]
                if not ends:
                    break  # incomplete sequence; wait for more bytes
                end = min(ends)
                seq = buf[i:end + 1]
                buf = buf[end + 1:]
                os.write(1, b"MOUSESEQ " + seq.replace(ESC, b"ESC") + b"\r\n")
            if b"\x03" in buf:  # Ctrl-C exits
                raise KeyboardInterrupt
    except KeyboardInterrupt:
        pass
    finally:
        os.write(1, b"\x1b[?1000l\x1b[?1002l\x1b[?1006l")
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


if __name__ == "__main__":
    main()
