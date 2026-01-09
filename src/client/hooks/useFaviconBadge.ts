import { useEffect } from 'react'

export function useFaviconBadge(active: boolean) {
  useEffect(() => {
    const link = document.querySelector(
      'link[rel="icon"]'
    ) as HTMLLinkElement | null
    if (!link) {
      return
    }

    link.href = active ? '/favicon-badge.svg' : '/favicon.svg'
  }, [active])
}
