import { parseAndNormalizeAgentLogLine, type NormalizedEvent } from './eventTaxonomy'
import type {
  CostAttribution,
  CostAttributionComponent,
  CostAttributionComponentEstimate,
} from './types'

export interface EstimateCostAttributionOptions {
  maxPreviewLines?: number
  sampledTailBytes?: number
}

export const COST_ATTRIBUTION_ASSUMPTIONS =
  'Estimated relative resource usage from sampled preview log lines; heuristic only and not vendor billing.'

const COMPONENT_ORDER: CostAttributionComponent[] = [
  'user_input',
  'assistant_output',
  'tooling',
  'system_other',
]

const COMPONENT_WEIGHTS: Record<CostAttributionComponent, number> = {
  user_input: 1,
  assistant_output: 1.25,
  tooling: 0.9,
  system_other: 0.5,
}

const MIN_TOKEN_UNITS_BY_COMPONENT: Record<CostAttributionComponent, number> = {
  user_input: 1,
  assistant_output: 1,
  tooling: 2,
  system_other: 1,
}

const TOKEN_CHAR_RATIO = 4
const PERCENT_SCALE = 10 // one decimal place

type ComponentAccumulator = Record<
  CostAttributionComponent,
  {
    tokenUnits: number
    estimatedUnits: number
    eventCount: number
  }
>

function createAccumulator(): ComponentAccumulator {
  return {
    user_input: { tokenUnits: 0, estimatedUnits: 0, eventCount: 0 },
    assistant_output: { tokenUnits: 0, estimatedUnits: 0, eventCount: 0 },
    tooling: { tokenUnits: 0, estimatedUnits: 0, eventCount: 0 },
    system_other: { tokenUnits: 0, estimatedUnits: 0, eventCount: 0 },
  }
}

function roundTo(value: number, places: number): number {
  const multiplier = 10 ** places
  return Math.round(value * multiplier) / multiplier
}

function mapEventToComponent(event: NormalizedEvent): CostAttributionComponent {
  if (event.kind === 'tool_call' || event.kind === 'tool_result' || event.role === 'tool') {
    return 'tooling'
  }
  if (event.role === 'user') {
    return 'user_input'
  }
  if (event.role === 'assistant') {
    return 'assistant_output'
  }
  return 'system_other'
}

function estimateTokenLikeUnits(
  text: string,
  component: CostAttributionComponent
): number {
  const trimmed = text.trim()
  const textUnits = trimmed.length > 0
    ? Math.ceil(trimmed.length / TOKEN_CHAR_RATIO)
    : 0
  return Math.max(MIN_TOKEN_UNITS_BY_COMPONENT[component], textUnits)
}

function calculateSharePercents(
  accumulators: ComponentAccumulator,
  totalEstimatedUnits: number
): Record<CostAttributionComponent, number> {
  const zeroShares: Record<CostAttributionComponent, number> = {
    user_input: 0,
    assistant_output: 0,
    tooling: 0,
    system_other: 0,
  }

  if (totalEstimatedUnits <= 0) {
    return zeroShares
  }

  const ranked = COMPONENT_ORDER.map((component, index) => {
    const rawScaled = (accumulators[component].estimatedUnits / totalEstimatedUnits) * 100 * PERCENT_SCALE
    const scaledFloor = Math.floor(rawScaled)
    return {
      component,
      index,
      scaled: scaledFloor,
      fractional: rawScaled - scaledFloor,
    }
  })

  let remaining = (100 * PERCENT_SCALE) - ranked.reduce((sum, item) => sum + item.scaled, 0)
  if (remaining > 0) {
    const byRemainder = [...ranked].sort((a, b) => {
      if (b.fractional !== a.fractional) {
        return b.fractional - a.fractional
      }
      return a.index - b.index
    })

    let cursor = 0
    while (remaining > 0) {
      const target = byRemainder[cursor % byRemainder.length]
      target.scaled += 1
      remaining -= 1
      cursor += 1
    }
  }

  const shares = { ...zeroShares }
  for (const item of ranked) {
    shares[item.component] = item.scaled / PERCENT_SCALE
  }
  return shares
}

export function estimateCostAttribution(
  lines: string[],
  options: EstimateCostAttributionOptions = {}
): CostAttribution {
  const accumulators = createAccumulator()
  let parsedLineCount = 0
  let malformedLineCount = 0
  let emptyLineCount = 0

  for (const line of lines) {
    if (!line.trim()) {
      emptyLineCount += 1
      continue
    }

    const parsed = parseAndNormalizeAgentLogLine(line)
    if (!parsed) {
      emptyLineCount += 1
      continue
    }

    if (parsed.parsed) {
      parsedLineCount += 1
    } else {
      malformedLineCount += 1
    }

    for (const event of parsed.events) {
      const component = mapEventToComponent(event)
      const tokenUnits = estimateTokenLikeUnits(event.text, component)
      accumulators[component].tokenUnits += tokenUnits
      accumulators[component].estimatedUnits +=
        tokenUnits * COMPONENT_WEIGHTS[component]
      accumulators[component].eventCount += 1
    }
  }

  const totalTokenUnits = COMPONENT_ORDER.reduce(
    (sum, component) => sum + accumulators[component].tokenUnits,
    0
  )
  const totalEstimatedRaw = COMPONENT_ORDER.reduce(
    (sum, component) => sum + accumulators[component].estimatedUnits,
    0
  )
  const sharePercents = calculateSharePercents(accumulators, totalEstimatedRaw)

  const components: CostAttributionComponentEstimate[] = COMPONENT_ORDER.map((component) => ({
    component,
    tokenUnits: accumulators[component].tokenUnits,
    estimatedUnits: roundTo(accumulators[component].estimatedUnits, 2),
    sharePercent: sharePercents[component],
    eventCount: accumulators[component].eventCount,
  }))

  return {
    assumptions: COST_ATTRIBUTION_ASSUMPTIONS,
    components,
    totalTokenUnits,
    totalEstimatedUnits: roundTo(totalEstimatedRaw, 2),
    sampling: {
      sampledLineCount: lines.length,
      parsedLineCount,
      malformedLineCount,
      emptyLineCount,
      maxPreviewLines: options.maxPreviewLines ?? lines.length,
      sampledTailBytes: options.sampledTailBytes ?? 0,
    },
  }
}
