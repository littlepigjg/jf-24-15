import archiver from 'archiver'
import { QrService } from '../../services/QrService.js'
import { StatsService } from '../../services/StatsService.js'
import { qrCodeRepository } from '../../repositories/QrCodeRepository.js'
import { exportTaskRepository } from '../../repositories/ExportTaskRepository.js'
import { CloudStorageService } from '../../services/CloudStorageService.js'
import type { QrCode, ScanRecord, ExportTask, ExportChunk, ExportTaskStatus, ExportFormat, ExportProgress } from '../../../shared/types.js'
import type { Response } from 'express'

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function buildCsv(headers: string[], rows: (string | number)[][]): string {
  const head = headers.map(escapeCsv).join(',')
  const body = rows.map((r) => r.map(escapeCsv).join(',')).join('\n')
  return head + (body ? '\n' + body : '')
}

async function resolveQrCodes(ids?: string[]): Promise<QrCode[]> {
  if (ids && ids.length > 0) {
    const result: QrCode[] = []
    for (const id of ids) {
      const qr = await qrCodeRepository.getById(id)
      if (qr) result.push(qr)
    }
    return result
  }
  return qrCodeRepository.getAll()
}

function safeFilename(baseName: string, usedNames: Map<string, number>, ext: string): string {
  const safe = baseName.replace(/[<>:"/\\|?*]/g, '_')
  let filename = `${safe}.${ext}`
  const count = usedNames.get(filename) || 0
  if (count > 0) {
    filename = `${safe}_${count}.${ext}`
  }
  usedNames.set(filename, count + 1)
  return filename
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

const DEFAULT_CHUNK_SIZE = 100
const DEFAULT_CONCURRENCY = 3
const MAX_RETRY_COUNT = 3

const runningTasks = new Map<string, { abort: boolean; paused: boolean }>()

function buildCsvHeaders(format: ExportFormat): string[] {
  if (format === 'csv' || format === 'full') {
    return [
      'ID',
      '名称',
      '类型',
      '短码',
      '目标URL',
      '启用状态',
      '扫描次数',
      '创建时间',
      '更新时间',
    ]
  }
  if (format === 'scans_csv') {
    return ['ID', '二维码ID', '短码', '时间', 'IP', 'UserAgent', '来源']
  }
  return []
}

function qrToCsvRow(qr: QrCode): (string | number)[] {
  return [
    qr.id,
    qr.name,
    qr.type,
    qr.shortCode,
    qr.targetUrl,
    qr.enabled ? '启用' : '禁用',
    qr.scanCount,
    qr.createdAt,
    qr.updatedAt,
  ]
}

function scanToCsvRow(r: ScanRecord): (string | number)[] {
  return [
    r.id,
    r.qrcodeId,
    r.shortCode,
    r.timestamp,
    r.ip,
    r.userAgent,
    r.referer || '',
  ]
}

function calculateProgress(task: ExportTask): ExportProgress {
  const now = new Date()
  const startedAt = task.startedAt || task.createdAt
  const startTime = new Date(startedAt).getTime()
  const elapsedMs = now.getTime() - startTime
  const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000))

  const completedChunks = task.chunks.filter((c) => c.status === 'completed').length
  const processedItems = task.chunks
    .filter((c) => c.status === 'completed')
    .reduce((sum, c) => sum + (c.endIndex - c.startIndex), 0)

  const percentage = task.totalItems > 0 ? (processedItems / task.totalItems) * 100 : 0

  const averageSpeed = elapsedSeconds > 0 ? processedItems / elapsedSeconds : 0

  const remainingItems = task.totalItems - processedItems
  const estimatedRemainingSeconds = averageSpeed > 0 ? Math.ceil(remainingItems / averageSpeed) : 0

  return {
    taskId: task.id,
    status: task.status,
    totalItems: task.totalItems,
    processedItems,
    uploadedChunks: completedChunks,
    totalChunks: task.totalChunks,
    percentage: Math.round(percentage * 100) / 100,
    estimatedRemainingSeconds,
    averageSpeed: Math.round(averageSpeed * 100) / 100,
    startedAt,
    elapsedSeconds,
  }
}

function createChunks(totalItems: number, chunkSize: number, taskId: string): ExportChunk[] {
  const chunks: ExportChunk[] = []
  const totalChunks = Math.ceil(totalItems / chunkSize)

  for (let i = 0; i < totalChunks; i++) {
    const startIndex = i * chunkSize
    const endIndex = Math.min(startIndex + chunkSize, totalItems)
    chunks.push({
      id: `${taskId}_chunk_${i}`,
      taskId,
      index: i,
      startIndex,
      endIndex,
      itemIds: [],
      status: 'pending',
      retryCount: 0,
    })
  }

  return chunks
}

async function processCsvChunk(
  qrcodes: QrCode[],
  format: ExportFormat,
  includeHeader: boolean,
): Promise<string> {
  const headers = buildCsvHeaders(format)
  const rows: (string | number)[][] = []

  if (format === 'csv' || format === 'full') {
    for (const qr of qrcodes) {
      rows.push(qrToCsvRow(qr))
    }
  } else if (format === 'scans_csv') {
    const allRecords: ScanRecord[] = []
    for (const qr of qrcodes) {
      const result = await StatsService.listScanRecords(1, 1000000, qr.id)
      allRecords.push(...result.items)
    }
    for (const r of allRecords) {
      rows.push(scanToCsvRow(r))
    }
  }

  let csv = ''
  if (includeHeader && headers.length > 0) {
    csv = buildCsv(headers, rows)
  } else {
    csv = rows.map((r) => r.map(escapeCsv).join(',')).join('\n')
    if (rows.length > 0) csv = '\n' + csv
  }

  return csv
}

async function processZipChunk(qrcodes: QrCode[], prefix: string = ''): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const chunks: Buffer[] = []

    archive.on('data', (chunk: Buffer) => chunks.push(chunk))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.on('error', reject)

    const usedNames = new Map<string, number>()
    void (async () => {
      for (const qr of qrcodes) {
        const filename = safeFilename(qr.name || qr.shortCode, usedNames, 'png')
        try {
          const buf = await QrService.generatePngBuffer(qr)
          archive.append(buf, { name: prefix + filename })
        } catch {
          // skip failed
        }
      }
      await archive.finalize()
    })()
  })
}

export const ExportService = {
  async pipeQrCodePngsZip(res: Response, qrcodeIds?: string[]): Promise<void> {
    const qrcodes = await resolveQrCodes(qrcodeIds)
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message })
    })
    archive.pipe(res)

    const usedNames = new Map<string, number>()
    for (const qr of qrcodes) {
      const filename = safeFilename(qr.name || qr.shortCode, usedNames, 'png')
      try {
        const buf = await QrService.generatePngBuffer(qr)
        archive.append(buf, { name: filename })
      } catch {
        // skip failed
      }
    }
    await archive.finalize()
  },

  async buildStatsCsv(qrcodeIds?: string[]): Promise<string> {
    const qrcodes = await resolveQrCodes(qrcodeIds)
    const headers = [
      'ID',
      '名称',
      '类型',
      '短码',
      '目标URL',
      '启用状态',
      '扫描次数',
      '创建时间',
      '更新时间',
    ]
    const rows: (string | number)[][] = []
    for (const qr of qrcodes) {
      rows.push([
        qr.id,
        qr.name,
        qr.type,
        qr.shortCode,
        qr.targetUrl,
        qr.enabled ? '启用' : '禁用',
        qr.scanCount,
        qr.createdAt,
        qr.updatedAt,
      ])
    }
    return buildCsv(headers, rows)
  },

  async buildScanRecordsCsv(qrcodeIds?: string[]): Promise<string> {
    let records: ScanRecord[]
    if (qrcodeIds && qrcodeIds.length > 0) {
      records = []
      for (const id of qrcodeIds) {
        const result = await StatsService.listScanRecords(1, 1000000, id)
        records.push(...result.items)
      }
    } else {
      const result = await StatsService.listScanRecords(1, 1000000)
      records = result.items
    }
    const headers = ['ID', '二维码ID', '短码', '时间', 'IP', 'UserAgent', '来源']
    const rows: (string | number)[][] = []
    for (const r of records) {
      rows.push([
        r.id,
        r.qrcodeId,
        r.shortCode,
        r.timestamp,
        r.ip,
        r.userAgent,
        r.referer || '',
      ])
    }
    return buildCsv(headers, rows)
  },

  async pipeFullExportZip(res: Response, qrcodeIds?: string[]): Promise<void> {
    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message })
    })
    archive.pipe(res)

    const statsCsv = await this.buildStatsCsv(qrcodeIds)
    archive.append(statsCsv, { name: 'qrcodes_stats.csv' })

    const scansCsv = await this.buildScanRecordsCsv(qrcodeIds)
    archive.append(scansCsv, { name: 'scan_records.csv' })

    const qrcodes = await resolveQrCodes(qrcodeIds)
    const usedNames = new Map<string, number>()
    for (const qr of qrcodes) {
      const filename = safeFilename(qr.name || qr.shortCode, usedNames, 'png')
      try {
        const buf = await QrService.generatePngBuffer(qr)
        archive.append(buf, { name: `qrcodes/${filename}` })
      } catch {
        // skip
      }
    }
    await archive.finalize()
  },

  async listTasks(): Promise<ExportTask[]> {
    return exportTaskRepository.getAll()
  },

  async getTaskById(id: string): Promise<ExportTask | undefined> {
    return exportTaskRepository.getById(id)
  },

  async createTask(params: {
    name?: string
    format: ExportFormat
    qrcodeIds?: string[]
    chunkSize?: number
    concurrency?: number
  }): Promise<ExportTask> {
    const qrcodes = await resolveQrCodes(params.qrcodeIds)
    const totalItems = qrcodes.length

    if (totalItems === 0) {
      throw new Error('没有可导出的数据')
    }

    const chunkSize = params.chunkSize || DEFAULT_CHUNK_SIZE
    const concurrency = params.concurrency || DEFAULT_CONCURRENCY
    const totalChunks = Math.ceil(totalItems / chunkSize)

    const taskId = generateId()
    const now = new Date().toISOString()

    const chunks = createChunks(totalItems, chunkSize, taskId)

    const qrIds = qrcodes.map((q) => q.id)
    chunks.forEach((chunk) => {
      chunk.itemIds = qrIds.slice(chunk.startIndex, chunk.endIndex)
    })

    const task: ExportTask = {
      id: taskId,
      name: params.name || `导出任务_${new Date().toLocaleString('zh-CN')}`,
      format: params.format,
      qrcodeIds: qrIds,
      totalItems,
      totalChunks,
      chunkSize,
      concurrency,
      status: 'pending',
      chunks,
      progress: {
        taskId,
        status: 'pending',
        totalItems,
        processedItems: 0,
        uploadedChunks: 0,
        totalChunks,
        percentage: 0,
        estimatedRemainingSeconds: 0,
        averageSpeed: 0,
        startedAt: now,
        elapsedSeconds: 0,
      },
      createdAt: now,
    }

    await exportTaskRepository.create(task)
    return task
  },

  async startTask(taskId: string): Promise<ExportTask | undefined> {
    const task = await exportTaskRepository.getById(taskId)
    if (!task) return undefined

    if (task.status === 'completed' || task.status === 'running') {
      return task
    }

    const ctx = { abort: false, paused: false }
    runningTasks.set(taskId, ctx)

    const now = new Date().toISOString()
    const updates: Partial<ExportTask> = {
      status: 'running',
      startedAt: task.startedAt || now,
      resumedAt: task.status === 'paused' ? now : undefined,
    }

    const updatedTask = await exportTaskRepository.update(taskId, updates)
    if (!updatedTask) return undefined

    void this.runTaskWorker(taskId)

    return updatedTask
  },

  async pauseTask(taskId: string): Promise<boolean> {
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
  },

  async resumeTask(taskId: string): Promise<ExportTask | undefined> {
    const task = await exportTaskRepository.getById(taskId)
    if (!task) return undefined

    if (task.status !== 'paused') {
      return task
    }

    return this.startTask(taskId)
  },

  async deleteTask(taskId: string): Promise<boolean> {
    const ctx = runningTasks.get(taskId)
    if (ctx) {
      ctx.abort = true
      runningTasks.delete(taskId)
    }

    const task = await exportTaskRepository.getById(taskId)
    if (!task) return false

    try {
      await CloudStorageService.deleteChunks(taskId, task.totalChunks)
    } catch {
      // ignore
    }

    return exportTaskRepository.delete(taskId)
  },

  async getTaskProgress(taskId: string): Promise<ExportProgress | undefined> {
    const task = await exportTaskRepository.getById(taskId)
    if (!task) return undefined
    return calculateProgress(task)
  },

  async runTaskWorker(taskId: string): Promise<void> {
    const ctx = runningTasks.get(taskId)
    if (!ctx) return

    let task = await exportTaskRepository.getById(taskId)
    if (!task) return

    try {
      const pendingChunks = task.chunks.filter((c) => c.status === 'pending' || c.status === 'failed')
      const chunkQueue = [...pendingChunks].sort((a, b) => a.index - b.index)

      let activeWorkers = 0
      let currentIndex = 0

      const processNextChunk = async (): Promise<void> => {
        if (ctx.abort || ctx.paused) return
        if (currentIndex >= chunkQueue.length) return
        if (activeWorkers >= task.concurrency) return

        const chunk = chunkQueue[currentIndex]
        currentIndex++
        activeWorkers++

        try {
          await this.processChunk(taskId, chunk.id)
        } catch (err) {
          // chunk processing error, already handled in processChunk
          console.error(`[export] chunk ${chunk.id} failed:`, err)
        } finally {
          activeWorkers--

          task = (await exportTaskRepository.getById(taskId)) || task
          const allDone =
            currentIndex >= chunkQueue.length && activeWorkers === 0

          if (!ctx.abort && !ctx.paused && !allDone) {
            void processNextChunk()
          }

          if (allDone && !ctx.abort && !ctx.paused) {
            void this.finalizeTask(taskId)
          }
        }
      }

      for (let i = 0; i < task.concurrency && i < chunkQueue.length; i++) {
        void processNextChunk()
      }

      while (true) {
        const currentTask = await exportTaskRepository.getById(taskId)
        if (!currentTask) break

        const allCompleted = currentTask.chunks.every(
          (c) => c.status === 'completed' || c.status === 'failed',
        )
        const isPaused = currentTask.status === 'paused'
        const isAborted = ctx.abort

        if (allCompleted || isPaused || isAborted) {
          break
        }

        await new Promise((resolve) => setTimeout(resolve, 500))
      }

      const finalTask = await exportTaskRepository.getById(taskId)
      if (finalTask && finalTask.status === 'paused') {
        // paused, just return
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
        runningTasks.delete(taskId)
      }
    }
  },

  async processChunk(taskId: string, chunkId: string): Promise<void> {
    const task = await exportTaskRepository.getById(taskId)
    if (!task) throw new Error('Task not found')

    const chunkIndex = task.chunks.findIndex((c) => c.id === chunkId)
    if (chunkIndex === -1) throw new Error('Chunk not found')

    const chunk = task.chunks[chunkIndex]

    if (chunk.status === 'completed') return

    const ctx = runningTasks.get(taskId)
    if (ctx?.abort) return
    if (ctx?.paused) return

    const qrcodes: QrCode[] = []
    for (const id of chunk.itemIds) {
      const qr = await qrCodeRepository.getById(id)
      if (qr) qrcodes.push(qr)
    }

    const startTime = Date.now()

    try {
      task.chunks[chunkIndex] = {
        ...chunk,
        status: 'processing',
        startedAt: new Date().toISOString(),
      }
      await exportTaskRepository.update(taskId, { chunks: task.chunks })

      let data: string | Buffer

      if (task.format === 'zip') {
        data = await processZipChunk(qrcodes)
      } else {
        const includeHeader = chunk.index === 0
        data = await processCsvChunk(qrcodes, task.format, includeHeader)
      }

      if (ctx?.abort || ctx?.paused) {
        return
      }

      task.chunks[chunkIndex] = {
        ...task.chunks[chunkIndex],
        status: 'uploading',
      }
      await exportTaskRepository.update(taskId, { chunks: task.chunks })

      const uploadResult = await CloudStorageService.uploadChunk(taskId, chunk.index, data)

      const processingTimeMs = Date.now() - startTime
      task.chunks[chunkIndex] = {
        ...task.chunks[chunkIndex],
        status: 'completed',
        uploadedUrl: uploadResult.chunkId,
        completedAt: new Date().toISOString(),
        processingTimeMs,
      }
      await exportTaskRepository.update(taskId, { chunks: task.chunks })
    } catch (err) {
      const retryCount = chunk.retryCount + 1
      if (retryCount < MAX_RETRY_COUNT) {
        task.chunks[chunkIndex] = {
          ...chunk,
          status: 'pending',
          retryCount,
          errorMessage: (err as Error).message,
        }
      } else {
        task.chunks[chunkIndex] = {
          ...chunk,
          status: 'failed',
          retryCount,
          errorMessage: (err as Error).message,
        }
      }
      await exportTaskRepository.update(taskId, { chunks: task.chunks })
      throw err
    }
  },

  async finalizeTask(taskId: string): Promise<void> {
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
      const ext = task.format === 'zip' ? 'zip' : 'csv'
      const filename = `export_${task.id}.${ext}`

      const mergeResult = await CloudStorageService.mergeChunks(taskId, task.totalChunks, filename)

      const now = new Date().toISOString()
      await exportTaskRepository.update(taskId, {
        status: 'completed',
        downloadUrl: mergeResult.fileUrl,
        completedAt: now,
      })
    } catch (err) {
      await exportTaskRepository.update(taskId, {
        status: 'failed',
        errorMessage: (err as Error).message,
      })
    }
  },
}
