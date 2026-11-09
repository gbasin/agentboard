"""Emit two iTerm or SIXEL images through tmux passthrough whenever Enter is pressed."""
import base64
import struct
import sys
import zlib


def png(rgb):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('!2I5B', 8, 8, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress((b'\0' + bytes(rgb) * 8) * 8))
            + chunk(b'IEND', b''))


protocol = sys.argv[1] if len(sys.argv) > 1 else "iterm"


def render():
    esc = '\x1b'
    sys.stdout.write(esc + '[2J' + esc + '[H')
    for col, color in [(1, (255, 0, 0)), (12, (0, 0, 255))]:
        data = png(color)
        if protocol == 'sixel':
            rgb = ';'.join(str(round(c * 100 / 255)) for c in color)
            # Ten bands of six vertical pixels, each 60 pixels wide.
            image = (esc + f'[3;{col}H' + esc + 'Pq"1;1;60;60'
                     + '#1;2;' + rgb + '#1' + '-'.join(['!60~'] * 10) + esc + '\\')
        else:
            image = (esc + f'[3;{col}H' + esc + f']1337;File=inline=1;size={len(data)};'
                     + 'width=60px;height=60px:' + base64.b64encode(data).decode() + '\a')
        sys.stdout.write(esc + 'Ptmux;' + image.replace(esc, esc + esc) + esc + '\\')
    sys.stdout.flush()


print('Press Enter to render red and blue images', flush=True)
for _ in sys.stdin:
    render()
