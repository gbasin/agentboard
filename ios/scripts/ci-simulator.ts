/** Pin CI discovery without overriding an explicitly supplied local Simulator. */
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2'
const device = 'iPhone 17'
type SimulatorList = { devices: Record<string, { name: string; udid: string; isAvailable: boolean }[]> }

export function ciSimulator(data: SimulatorList): string {
  const phone = data.devices[runtime]?.find(item => item.name === device && item.isAvailable)
  if (!phone) throw new Error(`No available ${device} Simulator for ${runtime}`)
  return phone.udid
}

if (import.meta.main) console.log(ciSimulator(await Bun.stdin.json()))
