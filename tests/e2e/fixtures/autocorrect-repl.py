#!/usr/bin/env python3
"""Real readline editor: DEL, navigation, and CR behave like terminal prompt entry."""
import json
import locale
# The e2e server deliberately uses LC_ALL=C; the real keyboard emits UTF-8.
for encoding in ('C.UTF-8', 'en_US.UTF-8'):
    try:
        locale.setlocale(locale.LC_CTYPE, encoding)
        break
    except locale.Error:
        pass
import readline

print('AUTOCORRECT READY', flush=True)
while True:
    try:
        line = input('prompt> ')
    except (EOFError, KeyboardInterrupt):
        break
    print('SUBMITTED:' + json.dumps(line, ensure_ascii=False), flush=True)
