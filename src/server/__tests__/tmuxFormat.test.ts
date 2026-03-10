import { describe, expect, test } from 'bun:test'
import {
  TMUX_FIELD_SEPARATOR,
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
} from '../tmuxFormat'

describe('tmuxFormat', () => {
  test('buildTmuxFormat joins fields with tabs for parsed tmux output', () => {
    const format = buildTmuxFormat([
      '#{session_name}',
      '#{window_id}',
      '#{pane_current_path}',
    ])

    expect(TMUX_FIELD_SEPARATOR).toBe('\t')
    expect(format).toBe(
      `#{session_name}${TMUX_FIELD_SEPARATOR}#{window_id}${TMUX_FIELD_SEPARATOR}#{pane_current_path}`
    )
  })

  test('splitTmuxFields preserves printable delimiter text inside values', () => {
    const line = [
      'sess ||| name',
      'win ||| title',
      "/tmp/path with ||| pipes and 'quotes'",
      `"sh -lc 'sleep 30'"`,
    ].join(TMUX_FIELD_SEPARATOR)

    expect(splitTmuxFields(line, 4)).toEqual([
      'sess ||| name',
      'win ||| title',
      "/tmp/path with ||| pipes and 'quotes'",
      `"sh -lc 'sleep 30'"`,
    ])
  })

  test('splitTmuxFields rejects malformed rows with the wrong field count', () => {
    expect(splitTmuxFields(`alpha${TMUX_FIELD_SEPARATOR}beta`, 3)).toBeNull()
  })

  test('splitTmuxLines preserves leading and trailing field spaces', () => {
    const line = [
      '  session-with-leading-space',
      'window-with-trailing-space  ',
    ].join(TMUX_FIELD_SEPARATOR)

    expect(splitTmuxLines(`${line}\n`)).toEqual([line])
    expect(splitTmuxFields(splitTmuxLines(`${line}\n`)[0]!, 2)).toEqual([
      '  session-with-leading-space',
      'window-with-trailing-space  ',
    ])
  })

  test('withTmuxUtf8Flag prepends -u once', () => {
    expect(withTmuxUtf8Flag(['list-windows', '-a'])).toEqual([
      '-u',
      'list-windows',
      '-a',
    ])
    expect(withTmuxUtf8Flag(['-u', 'list-windows', '-a'])).toEqual([
      '-u',
      'list-windows',
      '-a',
    ])
  })
})
