import { exportTaskRepository } from '../../../repositories/ExportTaskRepository.js'
import { processChunk, verifyChunkIntegrity } from './chunkProcessor.js'
import { mergeCsvChunks } from './csv.js'
import { mergeZipFiles, readZipManifest, cleanupTempDir } from './zip.js'
import { computeProgress } from './progress.js'
import { CHUNKS_DIR, FILES_DIR, finalFilename, chunkFilename, chunkTempDir, ensureDir, fileExists } from './common.js'
import type { ExportTask, ExportProgress, ExportFormat } from '../../../../shared/types.js'
import path from 'node:path'
import fs from 'node:fs/promises'

interface TaskContext {
  abort: boolean
  paused: boolean
}

const runningTasks = new Map<string, TaskContext>()

export function getTaskContext(taskId: string): TaskContext | undefined {
  return runningTasks.get(taskId)
}

export function setTaskContext(taskId: string, ctx: TaskContext): void {
  runningTasks.set(taskId, ctx)
}

export function deleteTaskContext(taskId: string): void {
  runningTasks.delete(taskId)
}

export function isTaskRunning(taskId: string): boolean {
  return runningTasks.has(taskId)
}

export async function startTask(taskId: string): Promise<ExportTask | undefined> {
  const task = await exportTaskRepository.getById(taskId)
  if (!task) return undefined

  if (task.status === 'completed' || task.status === 'running') {
    return task
  }

  const ctx: TaskContext = { abort: false, paused: false }
  setTaskContext(taskId, ctx)

  const now = new Date().toISOString()
  const updates: Partial<ExportTask> = {
    status: 'running',
    startedAt: task.startedAt || now,
    lastRunningAt: now,
    resumedAt: task.status === 'paused' ? now : undefined,
  }

  const updatedTask = await exportTaskRepository.update(taskId, updates)
  if (!updatedTask) return undefined

  void runTaskWorker(taskId)

  return updatedTask
}

export async function pauseTask(taskId: string): Promise<boolean> {
  const ctx = runningTasks.get(taskId)
  if (ctx) {
    ctx.paused = true
  }

  const task = await exportTaskRepository.getById(taskId)
  if (!task) return false

  if (task.status === 'running' || task.status === 'pending') {
    await exportTaskRepository.update(taskId, {
      status: 'paused',
      pausedAt: new Date().toISOString(),
    })
    return true
  }

  return false
}

export async function resumeTask(taskId: string): Promise<ExportTask | undefined> {
  const task = await exportTaskRepository.getById(taskId)
  if (!task) return undefined

  if (task.status !== 'paused') {
    return task
  }

  return startTask(taskId)
}

export async function getTaskProgress(taskId: string): Promise<ExportProgress | undefined> {
  const task = await exportTaskRepository.getById(taskId)
  if (!task) return undefined
  return computeProgress(task)
}

async function runTaskWorker(taskId: string): Promise<void> {
  const ctx = runningTasks.get(taskId)
  if (!ctx) return

  let task = await exportTaskRepository.getById(taskId)
  if (!task) return

  try {
    const pendingChunks = task.chunks.filter(
      (c) => c.status === 'pending' || c.status === 'failed',
    )
    const chunkQueue = [...pendingChunks].sort((a, b) => a.index - b.index)

    let activeWorkers = 0
    let currentIndex = 0
    let finalizeScheduled = false

    const scheduleNext = (): void => {
      if (ctx.abort || ctx.paused) return
      if (currentIndex >= chunkQueue.length) return
      if (activeWorkers >= task.concurrency) return

      const chunk = chunkQueue[currentIndex]
      currentIndex++
      activeWorkers++

      void (async () => {
        try {
          await processChunk(taskId, chunk.id, ctx)
        } catch (err) {
          console.error(`[export] chunk ${chunk.id} failed:`, err)
        } finally {
          activeWorkers--

          task = (await exportTaskRepository.getById(taskId)) || task

          const allDone =
            currentIndex >= chunkQueue.length && activeWorkers === 0

          if (!ctx.abort && !ctx.paused && !allDone) {
            scheduleNext()
          }

          if (allDone && !ctx.abort && !ctx.paused && !finalizeScheduled) {
            finalizeScheduled = true
            void finalizeTask(taskId)
          }
        }
      })()

      scheduleNext()
    }

    scheduleNext()

    while (true) {
      const currentTask = await exportTaskRepository.getById(taskId)
      if (!currentTask) break

      const allCompleted = currentTask.chunks.every(
        (c) => c.status === 'completed' || c.status === 'failed',
      )
      const isPaused = currentTask.status === 'paused'

      if (allCompleted || isPaused || ctx.abort) {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const finalTask = await exportTaskRepository.getById(taskId)
    if (finalTask && finalTask.status === 'paused') {
      return
    }
  } catch (err) {
    console.error('[export] task worker error:', err)
    await exportTaskRepository.update(taskId, {
      status: 'failed',
      errorMessage: (err as Error).message,
    })
  } finally {
    const finalTask = await exportTaskRepository.getById(taskId)
    if (finalTask && finalTask.status !== 'paused') {
      deleteTaskContext(taskId)
    }
  }
}

async function finalizeTask(taskId: string): Promise<void> {
  const task = await exportTaskRepository.getById(taskId)
  if (!task) return

  const failedChunks = task.chunks.filter((c) => c.status === 'failed')
  if (failedChunks.length > 0) {
    await exportTaskRepository.update(taskId, {
      status: 'failed',
      errorMessage: `${failedChunks.length} 个分片处理失败`,
    })
    return
  }

  const completedChunks = task.chunks.filter((c) => c.status === 'completed')
  if (completedChunks.length !== task.totalChunks) {
    return
  }

  try {
    const filename = finalFilename(taskId, task.format)
    const outputPath = path.join(FILES_DIR, filename)
    await ensureDir(FILES_DIR)

    if (task.format === 'zip') {
      await finalizeZipTask(task, outputPath)
    } else {
      await finalizeCsvTask(task, outputPath)
    }

    const now = new Date().toISOString()
    await exportTaskRepository.update(taskId, {
      status: 'completed',
      downloadUrl: `/api/storage/files/${filename}`,
      finalFilename: filename,
      completedAt: now,
    })

    const tempDir = chunkTempDir(taskId)
    await cleanupTempDir(tempDir)
  } catch (err) {
    console.error('[export] finalize error:', err)
    await exportTaskRepository.update(taskId, {
      status: 'failed',
      errorMessage: `合并失败: ${(err as Error).message}`,
    })
  }
}

async function finalizeCsvTask(task: ExportTask, outputPath: string): Promise<void> {
  const chunkPaths: string[] = []
  for (let i = 0; i < task.totalChunks; i++) {
    const chunk = task.chunks.find((c) => c.index === i)
    if (!chunk || !chunk.filePath) {
      throw new Error(`分片 ${i} 文件路径缺失`)
    }
    if (!(await fileExists(chunk.filePath))) {
      throw new Error(`分片文件缺失: ${chunk.filePath}`)
    }
    chunkPaths.push(chunk.filePath)
  }

  await mergeCsvChunks({
    chunkPaths,
    outputPath,
    format: task.format,
  })
}

async function finalizeZipTask(task: ExportTask, outputPath: string): Promise<void> {
  const tempDir = chunkTempDir(task.id)
  const allEntries = []

  for (let i = 0; i < task.totalChunks; i++) {
    const chunk = task.chunks.find((c) => c.index === i)
    if (!chunk) continue

    const manifestPath = path.join(tempDir, `manifest_${i}.json`)
    const entries = await readZipManifest(manifestPath)
    allEntries.push(...entries)
  }

  if (allEntries.length === 0) {
    throw new Error('没有可合并的文件')
  }

  await mergeZipFiles({
    allEntries,
    outputPath,
  })
}

export async function recoverTasksOnStartup(): Promise<void> {
  const allTasks = await exportTaskRepository.getAll()

  for (const task of allTasks) {
    let needsUpdate = false
    const updates: Partial<ExportTask> = {}

    if (task.status === 'running') {
      updates.status = 'paused'
      updates.pausedAt = new Date().toISOString()
      needsUpdate = true
    }

    const fixedChunks = [...task.chunks]
    for (let i = 0; i < fixedChunks.length; i++) {
      const chunk = fixedChunks[i]

      if (chunk.status === 'processing' || chunk.status === 'uploading') {
        const valid = await verifyChunkIntegrity(chunk)
        if (valid) {
          fixedChunks[i] = { ...chunk, status: 'completed' }
        } else {
          fixedChunks[i] = {
            ...chunk,
            status: 'pending',
            retryCount: 0,
            errorMessage: '服务器重启，分片需重新处理',
          }
        }
        needsUpdate = true
      }

      if (chunk.status === 'completed' && chunk.filePath) {
        const valid = await verifyChunkIntegrity(chunk)
        if (!valid) {
          fixedChunks[i] = {
            ...chunk,
            status: 'pending',
            retryCount: 0,
            filePath: undefined,
            checksum: undefined,
            sizeBytes: undefined,
            errorMessage: '文件完整性校验失败，需重新处理',
          }
          needsUpdate = true
        }
      }
    }

    if (needsUpdate) {
      await exportTaskRepository.update(task.id, { ...updates, chunks: fixedChunks })
      console.log(`[export recovery] task ${task.id} state recovered`)
    }
  }
}
