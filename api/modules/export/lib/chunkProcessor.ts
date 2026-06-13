import fs from 'node:fs/promises'
import path from 'node:path'
import { qrCodeRepository } from '../../../repositories/QrCodeRepository.js'
import { exportTaskRepository } from '../../../repositories/ExportTaskRepository.js'
import { writeCsvChunk } from './csv.js'
import { writeZipChunkFiles, writeZipManifest, type ZipTempEntry } from './zip.js'
import {
  chunkFilename,
  chunkTempDir,
  CHUNKS_DIR,
  ensureDir,
  fileExists,
  computeChecksum,
  MAX_RETRY_COUNT,
} from './common.js'
import type { QrCode, ExportTask, ExportChunk, ExportFormat } from '../../../../shared/types.js'

export interface ChunkProcessResult {
  success: boolean
  filePath: string
  sizeBytes: number
  checksum: string
  rowCount?: number
  zipEntries?: ZipTempEntry[]
  processingTimeMs: number
}

export async function processChunk(
  taskId: string,
  chunkId: string,
  signal: { aborted?: boolean; paused?: boolean },
): Promise<ChunkProcessResult> {
  const task = await exportTaskRepository.getById(taskId)
  if (!task) throw new Error('Task not found')

  const chunkIndex = task.chunks.findIndex((c) => c.id === chunkId)
  if (chunkIndex === -1) throw new Error('Chunk not found')

  const chunk = task.chunks[chunkIndex]
  if (chunk.status === 'completed') {
    return {
      success: true,
      filePath: chunk.filePath || '',
      sizeBytes: chunk.sizeBytes || 0,
      checksum: chunk.checksum || '',
      processingTimeMs: 0,
    }
  }

  if (signal.aborted || signal.paused) {
    throw new Error('Aborted or paused before processing')
  }

  const qrcodes: QrCode[] = []
  for (const id of chunk.itemIds) {
    const qr = await qrCodeRepository.getById(id)
    if (qr) qrcodes.push(qr)
  }

  const startTime = Date.now()

  await updateChunkStatus(taskId, chunkIndex, 'processing', { startedAt: new Date().toISOString() })

  const tempDir = chunkTempDir(taskId)
  await ensureDir(tempDir)
  await ensureDir(CHUNKS_DIR)

  try {
    let result: ChunkProcessResult

    if (task.format === 'zip') {
      result = await processZipChunkToDisk(task, chunk, qrcodes, tempDir, signal)
    } else {
      result = await processCsvChunkToDisk(task, chunk, qrcodes, signal)
    }

    if (signal.aborted || signal.paused) {
      throw new Error('Aborted or paused during processing')
    }

    const processingTimeMs = Date.now() - startTime

    await updateChunkStatus(taskId, chunkIndex, 'completed', {
      filePath: result.filePath,
      sizeBytes: result.sizeBytes,
      checksum: result.checksum,
      completedAt: new Date().toISOString(),
      processingTimeMs,
    })

    const freshTask = await exportTaskRepository.getById(taskId)
    if (freshTask) {
      const newActiveMs = (freshTask.activeTimeMs || 0) + processingTimeMs
      await exportTaskRepository.update(taskId, { activeTimeMs: newActiveMs })
    }

    return { ...result, processingTimeMs }
  } catch (err) {
    const retryCount = chunk.retryCount + 1
    if (retryCount < MAX_RETRY_COUNT) {
      await updateChunkStatus(taskId, chunkIndex, 'pending', {
        retryCount,
        errorMessage: (err as Error).message,
      })
    } else {
      await updateChunkStatus(taskId, chunkIndex, 'failed', {
        retryCount,
        errorMessage: (err as Error).message,
      })
    }
    throw err
  }
}

async function processCsvChunkToDisk(
  task: ExportTask,
  chunk: ExportChunk,
  qrcodes: QrCode[],
  signal: { aborted?: boolean; paused?: boolean },
): Promise<ChunkProcessResult> {
  const filename = chunkFilename(task.id, chunk.index, task.format)
  const outputPath = path.join(CHUNKS_DIR, filename)
  const includeHeader = chunk.index === 0

  const { rowCount, sizeBytes } = await writeCsvChunk({
    outputPath,
    qrcodes,
    format: task.format,
    includeHeader,
    signal,
  })

  const checksum = await computeChecksum(outputPath)

  return {
    success: true,
    filePath: outputPath,
    sizeBytes,
    checksum,
    rowCount,
    processingTimeMs: 0,
  }
}

async function processZipChunkToDisk(
  task: ExportTask,
  chunk: ExportChunk,
  qrcodes: QrCode[],
  tempDir: string,
  signal: { aborted?: boolean; paused?: boolean },
): Promise<ChunkProcessResult> {
  const { entries, totalSizeBytes } = await writeZipChunkFiles({
    taskId: task.id,
    chunkIndex: chunk.index,
    tempDir,
    qrcodes,
    prefix: `qrcodes/`,
    signal,
  })

  const manifestPath = path.join(tempDir, `manifest_${chunk.index}.json`)
  await writeZipManifest({ manifestPath, entries })

  const sizeBytes = totalSizeBytes
  const checksum = entries.map((e) => e.archivePath).join('|')

  return {
    success: true,
    filePath: manifestPath,
    sizeBytes,
    checksum,
    zipEntries: entries,
    processingTimeMs: 0,
  }
}

async function updateChunkStatus(
  taskId: string,
  chunkIndex: number,
  status: ExportChunk['status'],
  extra: Partial<ExportChunk> = {},
): Promise<void> {
  const task = await exportTaskRepository.getById(taskId)
  if (!task) return

  const chunk = task.chunks[chunkIndex]
  if (!chunk) return

  task.chunks[chunkIndex] = { ...chunk, ...extra, status }
  await exportTaskRepository.update(taskId, { chunks: task.chunks })
}

export function buildChunkList(totalItems: number, chunkSize: number, taskId: string, qrIds: string[]): ExportChunk[] {
  const totalChunks = Math.ceil(totalItems / chunkSize)
  const chunks: ExportChunk[] = []

  for (let i = 0; i < totalChunks; i++) {
    const startIndex = i * chunkSize
    const endIndex = Math.min(startIndex + chunkSize, totalItems)
    chunks.push({
      id: `${taskId}_chunk_${i}`,
      taskId,
      index: i,
      startIndex,
      endIndex,
      itemIds: qrIds.slice(startIndex, endIndex),
      status: 'pending',
      retryCount: 0,
    })
  }

  return chunks
}

export async function verifyChunkIntegrity(chunk: ExportChunk): Promise<boolean> {
  if (chunk.status !== 'completed') return false
  if (!chunk.filePath) return false

  const exists = await fileExists(chunk.filePath)
  if (!exists) return false

  if (chunk.checksum && chunk.filePath.endsWith('.csv')) {
    try {
      const actual = await computeChecksum(chunk.filePath)
      return actual === chunk.checksum
    } catch {
      return false
    }
  }

  return true
}
