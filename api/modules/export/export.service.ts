import archiver from 'archiver'
import { QrService } from '../../services/QrService.js'
import { StatsService } from '../../services/StatsService.js'
import { qrCodeRepository } from '../../repositories/QrCodeRepository.js'
import { exportTaskRepository } from '../../repositories/ExportTaskRepository.js'
import { computeProgress } from './lib/progress.js'
import { buildChunkList } from './lib/chunkProcessor.js'
import {
  startTask as runnerStartTask,
  pauseTask as runnerPauseTask,
  resumeTask as runnerResumeTask,
  getTaskProgress as runnerGetProgress,
  deleteTaskContext,
  recoverTasksOnStartup,
} from './lib/taskRunner.js'
import { escapeCsvValue, safeFilename, DEFAULT_CHUNK_SIZE, DEFAULT_CONCURRENCY, generateId, CHUNKS_DIR, TEMP_ROOT } from './lib/common.js'
import { buildCsvHeaders, writeCsvChunk, mergeCsvChunks, qrCodeToCsvRow, scanRecordToCsvRow } from './lib/csv.js'
import type { QrCode, ScanRecord, ExportTask, ExportProgress, ExportFormat } from '../../../shared/types.js'
import type { Response } from 'express'

function buildCsv(headers: string[], rows: (string | number)[][]): string {
  const head = headers.map(escapeCsvValue).join(',')
  const body = rows.map((r) => r.map(escapeCsvValue).join(',')).join('\n')
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
    const headers = buildCsvHeaders('csv')
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
    const headers = buildCsvHeaders('scans_csv')
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

    const qrIds = qrcodes.map((q) => q.id)
    const chunks = buildChunkList(totalItems, chunkSize, taskId, qrIds)

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
        activeElapsedSeconds: 0,
      },
      activeTimeMs: 0,
      createdAt: now,
    }

    await exportTaskRepository.create(task)
    return task
  },

  async startTask(taskId: string): Promise<ExportTask | undefined> {
    return runnerStartTask(taskId)
  },

  async pauseTask(taskId: string): Promise<boolean> {
    return runnerPauseTask(taskId)
  },

  async resumeTask(taskId: string): Promise<ExportTask | undefined> {
    return runnerResumeTask(taskId)
  },

  async deleteTask(taskId: string): Promise<boolean> {
    deleteTaskContext(taskId)

    const task = await exportTaskRepository.getById(taskId)
    if (!task) return false

    return exportTaskRepository.delete(taskId)
  },

  async getTaskProgress(taskId: string): Promise<ExportProgress | undefined> {
    return runnerGetProgress(taskId)
  },

  async recoverTasks(): Promise<void> {
    await recoverTasksOnStartup()
  },
}
