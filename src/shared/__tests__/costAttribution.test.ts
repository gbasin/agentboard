import { describe, expect, test } from 'bun:test'
import { estimateCostAttribution } from '../costAttribution'

describe('costAttribution', () => {
  test('estimates mixed Claude/Codex/Pi events and malformed lines', () => {
    const lines = [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'hello there' }] }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'answer text' }],
        },
      }),
      JSON.stringify({ type: 'tool_use', name: 'search' }),
      JSON.stringify({ type: 'result', result: 'ok' }),
      JSON.stringify({
        type: 'user',
        source: 'pi',
        message: { role: 'user', content: 'ping' },
      }),
      'bad raw line',
    ]

    const estimate = estimateCostAttribution(lines, {
      maxPreviewLines: 100,
      sampledTailBytes: 65536,
    })

    expect(estimate.components).toEqual([
      {
        component: 'user_input',
        tokenUnits: 4,
        estimatedUnits: 4,
        sharePercent: 29.9,
        eventCount: 2,
      },
      {
        component: 'assistant_output',
        tokenUnits: 3,
        estimatedUnits: 3.75,
        sharePercent: 28.1,
        eventCount: 1,
      },
      {
        component: 'tooling',
        tokenUnits: 4,
        estimatedUnits: 3.6,
        sharePercent: 27,
        eventCount: 1,
      },
      {
        component: 'system_other',
        tokenUnits: 4,
        estimatedUnits: 2,
        sharePercent: 15,
        eventCount: 2,
      },
    ])

    expect(estimate.totalTokenUnits).toBe(15)
    expect(estimate.totalEstimatedUnits).toBe(13.35)
    expect(estimate.sampling).toEqual({
      sampledLineCount: 6,
      parsedLineCount: 5,
      malformedLineCount: 1,
      emptyLineCount: 0,
      maxPreviewLines: 100,
      sampledTailBytes: 65536,
    })
  })

  test('handles empty input with stable zero totals', () => {
    const estimate = estimateCostAttribution([], {
      maxPreviewLines: 100,
      sampledTailBytes: 65536,
    })

    expect(estimate.totalTokenUnits).toBe(0)
    expect(estimate.totalEstimatedUnits).toBe(0)
    expect(estimate.components).toEqual([
      {
        component: 'user_input',
        tokenUnits: 0,
        estimatedUnits: 0,
        sharePercent: 0,
        eventCount: 0,
      },
      {
        component: 'assistant_output',
        tokenUnits: 0,
        estimatedUnits: 0,
        sharePercent: 0,
        eventCount: 0,
      },
      {
        component: 'tooling',
        tokenUnits: 0,
        estimatedUnits: 0,
        sharePercent: 0,
        eventCount: 0,
      },
      {
        component: 'system_other',
        tokenUnits: 0,
        estimatedUnits: 0,
        sharePercent: 0,
        eventCount: 0,
      },
    ])
    expect(estimate.sampling).toEqual({
      sampledLineCount: 0,
      parsedLineCount: 0,
      malformedLineCount: 0,
      emptyLineCount: 0,
      maxPreviewLines: 100,
      sampledTailBytes: 65536,
    })
  })

  test('keeps deterministic one-decimal percentage rounding', () => {
    const lines = [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: 'aaaa' }] }),
      JSON.stringify({
        type: 'assistant',
        content: [{ type: 'text', text: 'bbbb' }],
      }),
      JSON.stringify({ type: 'result', result: 'cccc' }),
    ]

    const estimate = estimateCostAttribution(lines)
    const percentTotal = estimate.components.reduce(
      (sum, component) => sum + component.sharePercent,
      0
    )

    expect(estimate.totalEstimatedUnits).toBe(2.75)
    expect(estimate.components.map((component) => component.sharePercent)).toEqual([
      36.4,
      45.4,
      0,
      18.2,
    ])
    expect(percentTotal).toBe(100)
  })
})
