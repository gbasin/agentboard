#!/usr/bin/env python3
"""Bracketed-paste REPL fixture for the paste e2e test.

Models the terminal behavior of an agent CLI (e.g. Claude Code) that
agentboard attaches to AFTER startup:
  - enables bracketed paste (ESC[?2004h) once at startup and never re-emits
    it, so a browser xterm attaching later never observes the mode;
  - a bracketed paste (ESC[200~ ... ESC[201~) is HELD in an edit buffer;
  - a bare CR/LF outside a paste SUBMITS the buffer.

State is printed to the pane as single-line markers (newlines rendered as
'|') so the test can assert via `tmux capture-pane`:
  PASTE-REPL READY / HELD:<content> / SUBMITTED:<content>
"""
import os
import select
import sys
import termios
import tty

START = b"\x1b[200~"
END = b"\x1b[201~"

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)


def render(content: bytes) -> bytes:
    return content.replace(b"\r", b"|").replace(b"\n", b"|")


def main() -> None:
    tty.setraw(fd)
    os.write(1, b"\x1b[?2004h")
    os.write(1, b"PASTE-REPL READY\r\n")
    buf = b""
    raw = b""
    in_paste = False
    try:
        while True:
            readable, _, _ = select.select([fd], [], [], 0.05)
            if not readable:
                continue
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            raw += chunk
            while raw:
                if in_paste:
                    idx = raw.find(END)
                    if idx == -1:
                        break  # END not yet received; wait for more bytes
                    content = raw[:idx]
                    buf += content
                    raw = raw[idx + len(END):]
                    in_paste = False
                    os.write(1, b"HELD:" + render(content) + b"\r\n")
                    continue
                idx = raw.find(START)
                typed = raw if idx == -1 else raw[:idx]
                for byte_value in typed:
                    byte = bytes([byte_value])
                    if byte in (b"\r", b"\n"):
                        os.write(1, b"SUBMITTED:" + render(buf) + b"\r\n")
                        buf = b""
                    elif byte == b"\x03":  # Ctrl-C exits
                        raise KeyboardInterrupt
                    else:
                        buf += byte
                if idx == -1:
                    raw = b""
                    break
                raw = raw[idx + len(START):]
                in_paste = True
    except KeyboardInterrupt:
        pass
    finally:
        os.write(1, b"\x1b[?2004l")
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


if __name__ == "__main__":
    main()
