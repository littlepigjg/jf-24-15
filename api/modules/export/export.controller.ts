import type { Request, Response } from 'express'
import { ExportService } from './export.service.js'
import { parseIds, parseFormat, validateIdsExplicit } from '../../utils/parseIds.js'
import type { ExportFormat } from '../../../shared/types.js'

export type ExportMode = 'query' | 'body'

function sendError(res: Response, status: number, error: string): void {
  if (!res.headersSent) {
    res.status(status).json({ success: false, error })
  }
}

export async function handleExport(
  req: Request,
  res: Response,
  mode: ExportMode,
): Promise<void> {
  const idsResult = parseIds(req, { prefer: mode })
  const format = parseFormat(req, { prefer: mode })
  const validation = validateIdsExplicit(idsResult)

  if (!validation.valid) {
    sendError(res, 400, (validation as { valid: false; error: string }).error)
    return
  }

  const ids = validation.ids

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[export ${req.method}] format=${format}, source=${idsResult.source}, ` +
        `explicit=${idsResult.explicit}, idsCount=${ids?.length ?? 'all'}`,
    )
  }

  try {
    if (format === 'csv') {
      const csv = await ExportService.buildStatsCsv(ids)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="qrcodes_stats_${Date.now()}.csv"`,
      )
      res.send('\uFEFF' + csv)
      return
    }
    if (format === 'scans_csv') {
      const csv = await ExportService.buildScanRecordsCsv(ids)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="scan_records_${Date.now()}.csv"`,
      )
      res.send('\uFEFF' + csv)
      return
    }
    if (format === 'full') {
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="full_export_${Date.now()}.zip"`,
      )
      await ExportService.pipeFullExportZip(res, ids)
      return
    }
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="qrcodes_png_${Date.now()}.zip"`,
    )
    await ExportService.pipeQrCodePngsZip(res, ids)
  } catch (err) {
    console.error('[export controller] error:', err)
    sendError(res, 500, (err as Error).message)
  }
}

async function listTasks(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(String(req.query.page || '1'), 10) || 1
    const pageSize = parseInt(String(req.query.pageSize || '20'), 10) || 20
    const all = await ExportService.listTasks()
    const sorted = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const start = (page - 1) * pageSize
    const items = sorted.slice(start, start + pageSize)
    res.json({
      success: true,
      data: { items, total: sorted.length, page, pageSize },
    })
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

async function getTask(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params
    const task = await ExportService.getTaskById(id)
    if (!task) {
      res.status(404).json({ success: false, error: '任务不存在' })
      return
    }
    res.json({ success: true, data: task })
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

async function createTask(req: Request, res: Response): Promise<void> {
  try {
    const { name, format, ids, chunkSize, concurrency } = req.body as {
      name?: string
      format: ExportFormat
      ids?: string[]
      chunkSize?: number
      concurrency?: number
    }

    if (!format) {
      res.status(400).json({ success: false, error: '缺少 format 参数' })
      return
    }

    const task = await ExportService.createTask({
      name,
      format,
      qrcodeIds: ids,
      chunkSize,
      concurrency,
    })

    const startedTask = await ExportService.startTask(task.id)

    res.json({ success: true, data: startedTask || task })
  } catch (err) {
    console.error('[export controller] createTask error:', err)
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

async function pauseTask(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params
    const result = await ExportService.pauseTask(id)
    if (!result) {
      res.status(404).json({ success: false, error: '任务不存在或无法暂停' })
      return
    }
    const task = await ExportService.getTaskById(id)
    res.json({ success: true, data: task })
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

async function resumeTask(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params
    const task = await ExportService.resumeTask(id)
    if (!task) {
      res.status(404).json({ success: false, error: '任务不存在或无法恢复' })
      return
    }
    res.json({ success: true, data: task })
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

async function deleteTask(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params
    const result = await ExportService.deleteTask(id)
    if (!result) {
      res.status(404).json({ success: false, error: '任务不存在' })
      return
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

async function getTaskProgress(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params
    const progress = await ExportService.getTaskProgress(id)
    if (!progress) {
      res.status(404).json({ success: false, error: '任务不存在' })
      return
    }
    res.json({ success: true, data: progress })
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message })
  }
}

export const ExportController = {
  handleExport,
  listTasks,
  getTask,
  createTask,
  pauseTask,
  resumeTask,
  deleteTask,
  getTaskProgress,
}
