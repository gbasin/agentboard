import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { useNotifications } from '../hooks/useNotifications'

const globalAny = globalThis as typeof globalThis & {
  Notification?: typeof Notification
  Audio?: typeof Audio
  document?: Document
}

const originalNotification = globalAny.Notification
const originalAudio = globalAny.Audio
const originalDocument = globalAny.document

function HookHarness({ onReady }: { onReady: (api: ReturnType<typeof useNotifications>) => void }) {
  const api = useNotifications()
  onReady(api)
  return null
}

afterEach(() => {
  globalAny.Notification = originalNotification
  globalAny.Audio = originalAudio
  globalAny.document = originalDocument
})

describe('useNotifications', () => {
  test('requests permission and notifies with audio', () => {
    const notifications: Array<{ title: string; body?: string }> = []
    let requestCalls = 0
    const audioInstances: Array<{ playCalls: number; volume: number }> = []

    class NotificationMock {
      static permission = 'default'
      static requestPermission() {
        requestCalls += 1
        return Promise.resolve('granted')
      }

      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body })
      }
    }

    class AudioMock {
      volume = 1
      playCalls = 0
      constructor(_src: string) {
        audioInstances.push(this)
      }
      play() {
        this.playCalls += 1
        return Promise.resolve()
      }
    }

    globalAny.Notification = NotificationMock as unknown as typeof Notification
    globalAny.Audio = AudioMock as unknown as typeof Audio
    globalAny.document = { hidden: true } as Document

    let api: ReturnType<typeof useNotifications> | null = null

    act(() => {
      TestRenderer.create(
        <HookHarness
          onReady={(value) => {
            api = value
          }}
        />
      )
    })

    if (!api) {
      throw new Error('Expected hook API')
    }

    act(() => {
      api?.requestPermission()
    })

    expect(requestCalls).toBe(1)

    NotificationMock.permission = 'granted'

    act(() => {
      api?.notify('Hello', 'World')
    })

    expect(notifications).toEqual([{ title: 'Hello', body: 'World' }])
    expect(audioInstances[0]?.playCalls).toBe(1)
  })
})
