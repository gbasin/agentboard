/** Shared private-file publication and verification for recovery artifacts. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export function persistenceDirectory(dbPath: string) {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.recovery`)
}

function syncFile(file: string) {
  const fd = fs.openSync(file, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function publishFile(
  temporary: string,
  destination: string,
  exclusive = false
) {
  fs.chmodSync(temporary, 0o600)
  syncFile(temporary)
  if (exclusive) fs.linkSync(temporary, destination)
  else fs.renameSync(temporary, destination)
  syncFile(path.dirname(destination))
}

export async function checksumFile(file: string, bytes?: number) {
  const hash = createHash('sha256')
  if (bytes !== 0) {
    for await (const chunk of fs.createReadStream(
      file,
      bytes === undefined ? undefined : { start: 0, end: bytes - 1 }
    ))
      hash.update(chunk)
  }
  return hash.digest('hex')
}

/** Verify the copied bytes, so a source modified during copying cannot pass. */
export async function copyVerifiedFile(
  source: string,
  destination: string,
  checksum: string
) {
  const temporary = `${destination}.${randomUUID()}.partial`
  try {
    await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
    if ((await checksumFile(temporary)) !== checksum)
      throw new Error('Conversation failed verification')
    publishFile(temporary, destination, true)
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}
