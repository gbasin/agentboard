/** Small typed client for the persisted session library. */
export async function libraryRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const options: RequestInit = { method, signal }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    options.headers = { 'Content-Type': 'application/json' }
    options.body = JSON.stringify(body)
  }
  const response = await fetch(`/api/library${path}`, options)
  const data = await response.json()
  if (!response.ok)
    throw new Error(data.error || 'Unable to update saved sessions')
  return data as T
}
export const historyButton =
  'inline-flex min-h-[30px] items-center justify-center rounded border border-border px-2 py-1 text-[12px] text-secondary hover:bg-hover disabled:opacity-40 disabled:cursor-wait'
export function sizeLabel(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
