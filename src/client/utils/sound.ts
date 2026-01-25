/**
 * Web Audio API sound notifications for session status changes.
 * Generates tones programmatically - no external audio files needed.
 */

// Lazy AudioContext singleton
let audioContext: AudioContext | null = null

// Rate limiting: track last play time per sound type
const lastPlayTime: Record<string, number> = {}
const RATE_LIMIT_MS = 500 // Minimum ms between same sound type

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null

  // Handle closed context (can happen after iOS background/lifecycle events)
  if (audioContext?.state === 'closed') {
    audioContext = null
  }

  if (!audioContext) {
    const AudioContextCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return null
    audioContext = new AudioContextCtor()
  }
  return audioContext
}

/**
 * Prime the AudioContext for later playback.
 * Call this from a user gesture (click/tap) to unlock audio on iOS/Safari.
 */
export async function primeAudio(): Promise<void> {
  const ctx = getAudioContext()
  if (ctx && ctx.state === 'suspended') {
    await ctx.resume().catch(() => {})
  }
}

async function ensureRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {
      // Ignore resume failures (autoplay policy)
    })
  }
}

interface ToneOptions {
  frequencies: number[]
  durationMs: number
  attackMs: number
  peakGain: number
  type?: OscillatorType
}

async function playTone(options: ToneOptions): Promise<void> {
  const ctx = getAudioContext()
  if (!ctx) return

  await ensureRunning(ctx)

  // Guard: don't create nodes if context is still suspended (autoplay blocked)
  if (ctx.state !== 'running') return

  const { frequencies, durationMs, attackMs, peakGain, type = 'sine' } = options
  const now = ctx.currentTime
  const duration = durationMs / 1000
  const attack = attackMs / 1000

  // Create gain node for envelope
  const gainNode = ctx.createGain()
  gainNode.connect(ctx.destination)

  // Envelope: 0 -> peak (attack) -> hold -> 0 (release at end)
  const releaseStart = now + duration * 0.7 // Start release at 70% of duration
  gainNode.gain.setValueAtTime(0, now)
  gainNode.gain.linearRampToValueAtTime(peakGain, now + attack)
  gainNode.gain.setValueAtTime(peakGain, releaseStart)
  gainNode.gain.linearRampToValueAtTime(0, now + duration)

  // Create oscillators for each frequency
  const oscillators = frequencies.map((freq) => {
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, now)
    osc.connect(gainNode)
    return osc
  })

  // Start and stop all oscillators
  for (const osc of oscillators) {
    osc.start(now)
    osc.stop(now + duration)
  }

  // Cleanup using onended (more reliable than setTimeout when backgrounded)
  const lastOsc = oscillators[oscillators.length - 1]
  lastOsc.onended = () => {
    for (const osc of oscillators) {
      osc.disconnect()
    }
    gainNode.disconnect()
  }
}

/**
 * Play a short attention-grabbing ping for permission requests.
 * Higher pitched (880Hz), quick attack.
 */
export async function playPermissionSound(): Promise<void> {
  // Rate limit to prevent burst notifications
  const now = Date.now()
  if (now - (lastPlayTime.permission || 0) < RATE_LIMIT_MS) return
  lastPlayTime.permission = now

  try {
    await playTone({
      frequencies: [880],
      durationMs: 150,
      attackMs: 5,
      peakGain: 0.15,
      type: 'sine',
    })
  } catch {
    // Ignore all playback errors
  }
}

/**
 * Play a pleasant two-tone chime when a session becomes idle.
 * Lower frequencies (440Hz + 550Hz), gentler envelope.
 */
export async function playIdleSound(): Promise<void> {
  // Rate limit to prevent burst notifications
  const now = Date.now()
  if (now - (lastPlayTime.idle || 0) < RATE_LIMIT_MS) return
  lastPlayTime.idle = now

  try {
    await playTone({
      frequencies: [440, 550],
      durationMs: 300,
      attackMs: 10,
      peakGain: 0.08, // Lower to avoid clipping with two oscillators
      type: 'sine',
    })
  } catch {
    // Ignore all playback errors
  }
}
