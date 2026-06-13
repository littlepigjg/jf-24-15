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
  qrcodes: QrCode[]
  prefix?: string
  signal?: { aborted?: boolean; paused?: boolean }
}): Promise<{ entries: ZipTempEntry[]; totalSizeBytes: number; skippedCount: number }> {
  const { taskId, chunkIndex, tempDir, qrcodes, prefix = '', signal } = params
  const bucket = String(chunkIndex % 256).padStart(2, '0')
  const chunkDir = path.join(tempDir, bucket, `chunk_${chunkIndex}`)
  await ensureDir(chunkDir)

  const entries: ZipTempEntry[] = []
  let totalSizeBytes = 0
  let skippedCount = 0
  const usedNames = new Map<string, number>()

  for (let i = 0; i < qrcodes.length; i++) {
    if (signal?.aborted || signal?.paused) break
    const qr = qrcodes[i]
    const filename = safeFilename(qr.name || qr.shortCode, usedNames, 'png')
    const filePath = path.join(chunkDir, `${i}_${filename}`)
    const archivePath = prefix + filename

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
        for (const entry of allEntries) {
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
