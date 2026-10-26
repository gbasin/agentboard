/** Local-only link labels: preserve destination distinctions without fetching page titles. */
export function linkPresentation(destination: string, label?: string) {
  const display = destination.replace(/^https:\/\//i, '')
  let parsed: URL
  try { parsed = new URL(destination) } catch { return { title: label || destination, subtitle: label && label !== destination ? destination : undefined, detail: '' } }
  const bare = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
  const supplied = label?.trim()
  const meaningful = supplied && ![destination, display, destination.replace(/^https?:\/\//i, ''), bare].includes(supplied)
  const suffixStart = destination.search(/[?#]/)
  const suffix = suffixStart < 0 ? '' : destination.slice(suffixStart)
  const pr = parsed.hostname === 'github.com' && parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password
    ? /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/.*)?$/.exec(parsed.pathname) : null
  if (pr && !meaningful) {
    const anchor = /^#issuecomment-(\d+)$/.exec(parsed.hash)
    return { title: `${pr[2]} · PR #${pr[3]}`, subtitle: `github.com/${pr[1]}`,
      detail: [pr[4], parsed.search, anchor ? `Comment #${anchor[1]}` : parsed.hash].filter(Boolean).join(' · ') }
  }
  // HTTP remains explicit so http/https destinations never look identical.
  const base = (suffix ? destination.slice(0, -suffix.length) : destination).replace(/^https:\/\//i, '')
  return { title: meaningful ? supplied : base, subtitle: meaningful ? base : undefined, detail: suffix }
}
