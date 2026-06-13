import type { ExportTask, ExportProgress, ExportChunk } from '../../../../shared/types.js'

export function sumActiveProcessingMs(chunks: Pick<ExportChunk, 'processingTimeMs'>[]): number {
  return chunks.reduce<number>((sum, c) => sum + (c.processingTimeMs || 0), 0)
}

export function countProcessedItems(chunks: ExportChunk[]): number {
  return chunks
    .filter((c) => c.status === 'completed')
    .reduce<number>((sum, c) => sum + (c.endIndex - c.startIndex), 0)
}

export function countCompletedChunks(chunks: ExportChunk[]): number {
  return chunks.filter((c) => c.status === 'completed').length
}

export function computeElapsedWallSeconds(task: ExportTask): number {
  const start = task.startedAt || task.createdAt
  const end = task.status === 'completed' ? task.completedAt : undefined
  const endTime = end ? new Date(end).getTime() : Date.now()
  const startTime = new Date(start).getTime()
  const diff = endTime - startTime
  return Math.max(0, Math.floor(diff / 1000))
}

export function computeProgress(task: ExportTask): ExportProgress {
  const processedItems = countProcessedItems(task.chunks)
  const uploadedChunks = countCompletedChunks(task.chunks)
  const activeTimeMs = task.activeTimeMs || sumActiveProcessingMs(task.chunks)
  const activeSeconds = Math.max(1, Math.ceil(activeTimeMs / 1000))
  const elapsedSeconds = Math.max(1, computeElapsedWallSeconds(task))

  const percentage = task.totalItems > 0 ? (processedItems / task.totalItems) * 100 : 0

  const averageSpeed = processedItems > 0 ? processedItems / activeSeconds : 0

  const remainingItems = Math.max(0, task.totalItems - processedItems)
  const estimatedRemainingSeconds =
    averageSpeed > 0 ? Math.ceil(remainingItems / averageSpeed) : 0

  return {
    taskId: task.id,
    status: task.status,
    totalItems: task.totalItems,
    processedItems,
    uploadedChunks,
    totalChunks: task.totalChunks,
    percentage: Math.round(percentage * 100) / 100,
    estimatedRemainingSeconds,
    averageSpeed: Math.round(averageSpeed * 100) / 100,
    startedAt: task.startedAt || task.createdAt,
    elapsedSeconds,
    activeElapsedSeconds: activeSeconds,
  }
}

export function summarizeTaskStats(task: ExportTask): {
  completedChunks: number
  failedChunks: number
  pendingChunks: number
  processingChunks: number
  activeMs: number
} {
  let completed = 0
  let failed = 0
  let pending = 0
  let processing = 0
  for (const c of task.chunks) {
    switch (c.status) {
      case 'completed':
        completed++
        break
      case 'failed':
        failed++
        break
      case 'processing':
      case 'uploading':
        processing++
        break
      default:
        pending++
    }
  }
  return {
    completedChunks: completed,
    failedChunks: failed,
    pendingChunks: pending,
    processingChunks: processing,
    activeMs: task.activeTimeMs || sumActiveProcessingMs(task.chunks),
  }
}
