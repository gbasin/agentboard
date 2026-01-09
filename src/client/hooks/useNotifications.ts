import { useCallback, useEffect, useRef } from 'react'

export function useNotifications() {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    audioRef.current = new Audio('/notification.mp3')
    if (audioRef.current) {
      audioRef.current.volume = 0.6
    }
  }, [])

  const requestPermission = useCallback(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])

  const notify = useCallback((title: string, body: string) => {
    if (
      'Notification' in window &&
      document.hidden &&
      Notification.permission === 'granted'
    ) {
      new Notification(title, { body })
    }

    audioRef.current
      ?.play()
      .catch(() => {
        // Ignore audio playback errors (often blocked by autoplay policy).
      })
  }, [])

  return { requestPermission, notify }
}
