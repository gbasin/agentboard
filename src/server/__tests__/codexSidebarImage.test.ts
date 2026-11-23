import { expect, test } from 'bun:test'
import { codexImageLinks } from '../outputs/codexSidebarImage'

test('only local raster links in assistant output supply image paths', () => {
  const message = (role: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [
    { type: 'output_text', text: [
      '[board](<photos/board one.png>)', '[other](file:///tmp/image%202.webp)',
      '[remote](https://example.test/remote.jpg)', '[scheme](//example.test/other.gif)',
      '[broken](bad%ZZ.png)', '[document](paper.html)', '`[example](unused.gif)`',
      '```md\n[code](example.png)\n```',
    ].join('\n') },
    { type: 'input_text', text: '[input](ignored.jpg)' },
  ] } })
  expect(codexImageLinks(message('assistant'), '/project')).toEqual(['/project/photos/board one.png', '/tmp/image 2.webp'])
  expect(codexImageLinks(message('user'), '/project')).toEqual([])
  expect(codexImageLinks({ type: 'event_msg', payload: message('assistant').payload }, '/project')).toEqual([])
})
