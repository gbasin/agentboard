/**
 * Hibernating and History sections of the session sidebar.
 *
 * Under the default 'top' anchor each section renders below the Active list
 * with a separator above it. Under 'bottom' (desktop mirror) the sections sit
 * above Active, so the separator moves below them and their rows render in
 * reverse — the first row of each array is drawn lowest. Section toggles stay
 * above their own rows in both modes; History's "Show more" moves to the top
 * of its rows because older items extend upward.
 */
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'
import ChevronRightIcon from '@untitledui-icons/react/line/esm/ChevronRightIcon'
import type { AgentSession } from '@shared/types'
import type { SidebarAnchor } from '../stores/settingsStore'
import { useSettingsStore } from '../stores/settingsStore'
import HibernatingSessionItem from './HibernatingSessionItem'
import HistorySessionItem from './HistorySessionItem'

const HISTORY_PAGE_SIZE = 20

const sectionToggleClass =
  'flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted hover:text-primary'

function sectionBorderClass(anchor: SidebarAnchor): string {
  return anchor === 'bottom' ? 'border-b border-border' : 'border-t border-border'
}

function inAnchorOrder<T>(items: T[], anchor: SidebarAnchor): T[] {
  return anchor === 'bottom' ? [...items].reverse() : items
}

function SectionToggle({
  expanded,
  label,
  onToggle,
  children,
}: {
  expanded: boolean
  label: string
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <button type="button" onClick={onToggle} className={sectionToggleClass}>
      <span className="flex items-center gap-2">
        {expanded ? (
          <ChevronDownIcon className="h-4 w-4" />
        ) : (
          <ChevronRightIcon className="h-4 w-4" />
        )}
        {label}
      </span>
      {children}
    </button>
  )
}

interface DisplayPrefs {
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
}

interface HibernatingSectionProps extends DisplayPrefs {
  anchor: SidebarAnchor
  sessions: AgentSession[]
  selectedSessionId: string | null
  onSelect?: (sessionId: string) => void
  onWake?: (sessionId: string) => void
  onRename: (sessionId: string, newName: string) => void
  onMoveToHistory?: (sessionId: string) => void
}

export function HibernatingSection({
  anchor,
  sessions,
  selectedSessionId,
  onSelect,
  onWake,
  onRename,
  onMoveToHistory,
  ...prefs
}: HibernatingSectionProps) {
  const expanded = useSettingsStore((state) => state.hibernatingSessionsExpanded)
  const setExpanded = useSettingsStore((state) => state.setHibernatingSessionsExpanded)
  const rows = useMemo(() => inAnchorOrder(sessions, anchor), [sessions, anchor])

  if (sessions.length === 0) return null

  return (
    <div className={sectionBorderClass(anchor)}>
      <SectionToggle
        expanded={expanded}
        label="Hibernating"
        onToggle={() => setExpanded(!expanded)}
      >
        <span className="w-8 text-right text-xs text-muted">{sessions.length}</span>
      </SectionToggle>
      {expanded && (
        <div className="py-1">
          {rows.map((session) => (
            <HibernatingSessionItem
              key={session.sessionId}
              session={session}
              isSelected={selectedSessionId === session.sessionId}
              {...prefs}
              onSelect={(sessionId) => onSelect?.(sessionId)}
              onWake={(sessionId) => onWake?.(sessionId)}
              onRename={onRename}
              onMoveToHistory={onMoveToHistory}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface HistorySectionProps extends DisplayPrefs {
  anchor: SidebarAnchor
  sessions: AgentSession[]
  counterBump: boolean
  onCounterBumpComplete: () => void
  prefersReducedMotion: boolean | null
  onResume?: (sessionId: string) => void
  onPreview: (session: AgentSession) => void
}

export function HistorySection({
  anchor,
  sessions,
  counterBump,
  onCounterBumpComplete,
  prefersReducedMotion,
  onResume,
  onPreview,
  ...prefs
}: HistorySectionProps) {
  const expanded = useSettingsStore((state) => state.historySessionsExpanded)
  const setExpanded = useSettingsStore((state) => state.setHistorySessionsExpanded)
  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE)

  // Reset pagination when the panel is collapsed
  useEffect(() => {
    if (!expanded) setLimit(HISTORY_PAGE_SIZE)
  }, [expanded])

  const rows = useMemo(
    () => inAnchorOrder(sessions.slice(0, limit), anchor),
    [sessions, limit, anchor]
  )

  if (sessions.length === 0) return null

  const showMore = sessions.length > limit && (
    <button
      type="button"
      onClick={() => setLimit((prev) => prev + HISTORY_PAGE_SIZE)}
      className="w-full px-3 py-2 text-center text-xs text-muted hover:text-primary hover:bg-hover"
    >
      Show more ({sessions.length - limit} remaining)
    </button>
  )

  return (
    <div className={sectionBorderClass(anchor)}>
      <SectionToggle
        expanded={expanded}
        label="History"
        onToggle={() => setExpanded(!expanded)}
      >
        <motion.span
          className="w-8 text-right text-xs"
          animate={counterBump && !prefersReducedMotion ? { scale: [1, 1.3, 1] } : {}}
          transition={{ duration: 0.3 }}
          onAnimationComplete={onCounterBumpComplete}
        >
          {sessions.length}
        </motion.span>
      </SectionToggle>
      {expanded && (
        <div className="py-1">
          {anchor === 'bottom' && showMore}
          {rows.map((session) => (
            <HistorySessionItem
              key={session.sessionId}
              session={session}
              {...prefs}
              onResume={(sessionId) => onResume?.(sessionId)}
              onPreview={onPreview}
            />
          ))}
          {anchor !== 'bottom' && showMore}
        </div>
      )}
    </div>
  )
}
