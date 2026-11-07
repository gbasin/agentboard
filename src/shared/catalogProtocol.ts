/** Negotiate the catalog before any snapshot is sent on a replacement socket. */
export const CATALOG_VERSION = 2
export const CATALOG_RELOAD_MESSAGE = 'Agentboard was updated. Reload this tab to reconnect. Your saved recovery drafts remain on this device.'

export function catalogVersionFromUrl(url: URL): number | null {
  return url.searchParams.get('catalog') === String(CATALOG_VERSION) ? CATALOG_VERSION : null
}
