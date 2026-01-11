export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua)
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return iOS || iPadOS
}

export function isIOSPWA(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIOSDevice() && (navigator as { standalone?: boolean }).standalone === true
}
