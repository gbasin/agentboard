/** Content-addressed local thumbnail work; never includes image data on input. */
export interface ThumbnailRef {
  path: string
  offset: number
  index: number
  digest: string
  expectedBytes?: number
}
export type ThumbnailResponse = { id: number; body: Uint8Array } | { id: number; code: string }
