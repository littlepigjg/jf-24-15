import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import archiver from 'archiver'
import type { QrCode } from '../../../../shared/types.js'
import { QrService } from '../../../services/QrService.js'
import { ensureDir, safeFilename } from './common.js'

export interface ZipTempEntry {
  filePath: string
  archivePath: string
  sizeBytes: number
}

export async function writeZipChunkFiles(params: {
  taskId: string
  chunkIndex: number
  tempDir: string
  qrcodeIterator: AsyncGenerator<QrCode, void, unknown>
  prefix?: string
  signal?: { aborted?: boolean; paused?: boolean }
}): Promise<{ entries: ZipTempEntry[]; totalSizeBytes: number; skippedCount: number }> {
  const { taskId, chunkIndex, tempDir, qrcodeIterator, prefix = '', signal } = params
  const bucket = String(chunkIndex % 256).padStart(2, '0')
  const chunkDir = path.join(tempDir, bucket, `chunk_${chunkIndex}`)

  try {
    await fsPromises.rm(chunkDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  await ensureDir(chunkDir)

  const entries: ZipTempEntry[] = []
  let totalSizeBytes = 0
  let skippedCount = 0
  const usedNames = new Map<string, number>()
  let itemIndex = 0

  for await (const qr of qrcodeIterator) {
    if (signal?.aborted || signal?.paused) break

    const filename = safeFilename(qr.name || qr.shortCode, usedNames, 'png')
    const filePath = path.join(chunkDir, `${itemIndex}_${filename}`)
    const archivePath = prefix + filename
    itemIndex++

    try {
      const buf = await QrService.generatePngBuffer(qr)
      await fsPromises.writeFile(filePath, buf)
      const size = buf.length
      entries.push({ filePath, archivePath, sizeBytes: size })
      totalSizeBytes += size
    } catch {
      skippedCount++
    }
  }

  return { entries, totalSizeBytes, skippedCount }
}

export async function mergeZipFiles(params: {
  allEntries: ZipTempEntry[]
  outputPath: string
  zipLevel?: number
  signal?: { aborted?: boolean }
}): Promise<{ totalSizeBytes: number; entryCount: number }> {
  const { allEntries, outputPath, zipLevel = 9, signal } = params
  await ensureDir(path.dirname(outputPath))

  const deduped: ZipTempEntry[] = []
  const usedArchiveNames = new Map<string, number>()
  for (const entry of allEntries) {
    const base = path.basename(entry.archivePath)
    const dir = path.dirname(entry.archivePath)
    let finalArchivePath = entry.archivePath
    const count = usedArchiveNames.get(entry.archivePath) || 0
    if (count > 0) {
      const ext = path.extname(base)
      const stem = path.basename(base, ext)
      const newBase = `${stem}_${count}${ext}`
      finalArchivePath = dir === '.' ? newBase : path.join(dir, newBase)
    }
    usedArchiveNames.set(entry.archivePath, count + 1)
    deduped.push({ ...entry, archivePath: finalArchivePath })
  }

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: zipLevel } })
    const writeStream = fs.createWriteStream(outputPath)
    let entryCount = 0

    const abortHandler = () => {
      archive.abort()
      writeStream.destroy(new Error('Aborted'))
    }
    if (signal?.aborted !== undefined) {
      const abortTimer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(abortTimer)
          abortHandler()
        }
      }, 100)
      writeStream.on('close', () => clearInterval(abortTimer))
      writeStream.on('error', () => clearInterval(abortTimer))
    }

    writeStream.on('error', reject)
    archive.on('error', reject)
    writeStream.on('close', () => {
      resolve({ totalSizeBytes: writeStream.bytesWritten, entryCount })
    })

    archive.pipe(writeStream)

    void (async () => {
      try {
        for (const entry of deduped) {
          if (signal?.aborted) {
            abortHandler()
            return
          }
          try {
            await fsPromises.access(entry.filePath)
            archive.file(entry.filePath, { name: entry.archivePath })
            entryCount++
          } catch {
            // skip missing
          }
        }
        await archive.finalize()
      } catch (err) {
        archive.emit('error', err)
      }
    })()
  })
}

export async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fsPromises.rm(tempDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

export async function writeZipManifest(params: {
  manifestPath: string
  entries: ZipTempEntry[]
}): Promise<void> {
  await ensureDir(path.dirname(params.manifestPath))
  await fsPromises.writeFile(params.manifestPath, JSON.stringify(params.entries), 'utf-8')
}

export async function readZipManifest(manifestPath: string): Promise<ZipTempEntry[]> {
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf-8')
    return JSON.parse(raw) as ZipTempEntry[]
  } catch {
    return []
  }
}

export async function verifyZipManifestIntegrity(manifestPath: string): Promise<{ ok: boolean; entries: ZipTempEntry[] }> {
  try {
    const entries = await readZipManifest(manifestPath)
    if (entries.length === 0) return { ok: false, entries: [] }
    for (const entry of entries) {
      try {
        await fsPromises.access(entry.filePath)
      } catch {
        return { ok: false, entries }
      }
    }
    return { ok: true, entries }
  } catch {
    return { ok: false, entries: [] }
  }
}
