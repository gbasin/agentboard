"""Record native terminal input, with bracketed paste and mouse reporting enabled."""
import json
import os
import sys
import termios
import tty

saved = termios.tcgetattr(0)
try:
    tty.setraw(0)
    mouse = b'' if '--no-mouse' in sys.argv else b'\x1b[?1000h\x1b[?1006h'
    os.write(1, b'\x1b[2J\x1b[HNative paste test. Long-press the prompt below.\r\nOutput remains selectable.\r\n\x1b[?2004h' + mouse + b'prompt> ')
    with open(sys.argv[1], 'ab', buffering=0) as log:
        while True:
            chunk = os.read(0, 4096)
            if not chunk:
                break
            log.write((json.dumps({'hex': chunk.hex(), 'text': chunk.decode('utf8', 'replace')}) + '\n').encode())
            # Display input literally so a pasted newline cannot submit a command.
            if chunk == b'\r':
                os.write(1, b'\r\nENTER received\r\nprompt> ')
            elif not chunk.startswith(b'\x1b[<'):
                text = chunk.replace(b'\x1b[200~', b'').replace(b'\x1b[201~', b'')
                os.write(1, text.replace(b'\r\n', b'\n').replace(b'\r', b'\n').replace(b'\n', b'\r\n'))
finally:
    os.write(1, b'\x1b[?2004l\x1b[?1000l\x1b[?1006l')
    termios.tcsetattr(0, termios.TCSADRAIN, saved)
