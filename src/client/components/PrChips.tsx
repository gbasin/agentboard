import type { SessionPullRequest } from '../../shared/types'

export function PrChips({ prs }: { prs: SessionPullRequest[] }) {
  if (prs.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
      {prs.map((pr) => (
        <a
          key={pr.url}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="rounded-full bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-muted hover:text-accent"
          title={`${pr.repo}#${pr.number}`}
        >
          #{pr.number}
        </a>
      ))}
    </div>
  )
}
