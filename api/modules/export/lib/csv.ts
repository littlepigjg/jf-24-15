import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { QrCode, ScanRecord, ExportFormat } from '../../../../shared/types.js'
import { StatsService } from '../../../services/StatsService.js'
import { escapeCsvValue, ensureDir, fileExists } from './common.js'

export function buildCsvHeaders(format: ExportFormat): string[] {
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

export function qrCodeToCsvRow(qr: QrCode): string {
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
    .map(escapeCsvValue)
    .join(',')
}

export function scanRecordToCsvRow(r: ScanRecord): string {
  return [r.id, r.qrcodeId, r.shortCode, r.timestamp, r.ip, r.userAgent, r.referer || '']
    .map(escapeCsvValue)
    .join(',')
}

export function headersLine(headers: string[]): string {
  return headers.map(escapeCsvValue).join(',')
}

async function* iterateRows(
  qrcodes: QrCode[],
  format: ExportFormat,
): AsyncGenerator<string, void, unknown> {
  if (format === 'csv' || format === 'full') {
    for (const qr of qrcodes) {
      yield qrCodeToCsvRow(qr)
    }
  } else if (format === 'scans_csv') {
    for (const qr of qrcodes) {
      let page = 1
      const pageSize = 10000
      while (true) {
        const result = await StatsService.listScanRecords(page, pageSize, qr.id)
        for (const r of result.items) {
          yield scanRecordToCsvRow(r)
        }
        if (page * pageSize >= result.total || result.items.length === 0) {
          break
        }
        page++
      }
    }
  }
}

export async function writeCsvChunk(params: {
  outputPath: string
  qrcodes: QrCode[]
  format: ExportFormat
  includeHeader?: boolean
  signal?: { aborted?: boolean; paused?: boolean }
}): Promise<{ rowCount: number; sizeBytes: number }> {
  const { outputPath, qrcodes, format, includeHeader = false, signal } = params
  await ensureDir(require('node:path').dirname(outputPath))

  const headers = buildCsvHeaders(format)
  let rowCount = 0

  const source = new Readable({
    read() {},
    highWaterMark: 64 * 1024,
  })

  const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf-8' })

  if (includeHeader && headers.length > 0) {
    source.push(headersLine(headers) + '\n')
  }

  const pump = async (): Promise<void> => {
    try {
      for await (const row of iterateRows(qrcodes, format)) {
        if (signal?.aborted || signal?.paused) {
          source.push(null)
          return
        }
        source.push(row + '\n')
        rowCount++
      }
      source.push(null)
    } catch (err) {
      source.destroy(err as Error)
    }
  }

  const pumpPromise = pump()
  await pipeline(source, writeStream)
  await pumpPromise

  const sizeBytes = writeStream.bytesWritten
  return { rowCount, sizeBytes }
}

export async function mergeCsvChunks(params: {
  chunkPaths: string[]
  outputPath: string
  format: ExportFormat
  signal?: { aborted?: boolean }
}): Promise<{ totalSizeBytes: number }> {
  const { chunkPaths, outputPath, format, signal } = params
  await ensureDir(require('node:path').dirname(outputPath))

  const headers = buildCsvHeaders(format)
  const finalWrite = fs.createWriteStream(outputPath, { encoding: 'utf-8' })

  if (headers.length > 0) {
    await new Promise<void>((resolve, reject) => {
      finalWrite.write('\uFEFF' + headersLine(headers) + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  for (let i = 0; i < chunkPaths.length; i++) {
    if (signal?.aborted) throw new Error('Aborted')
    const chunkPath = chunkPaths[i]
    if (!(await fileExists(chunkPath))) {
      throw new Error(`分片文件缺失: ${chunkPath}`)
    }

    const readStream = fs.createReadStream(chunkPath, { encoding: 'utf-8' })
    let firstLineSkipped = false
    let lineBuffer = ''

    const stripHeader = new Transform({
      transform(chunk, _enc, callback) {
        if (signal?.aborted) {
          callback(new Error('Aborted'))
          return
        }
        if (firstLineSkipped) {
          callback(null, chunk)
          return
        }
        lineBuffer += String(chunk)
        const nl = lineBuffer.indexOf('\n')
        if (nl !== -1) {
          firstLineSkipped = true
          const rest = lineBuffer.slice(nl + 1)
          lineBuffer = ''
          callback(null, rest)
        } else {
          callback()
        }
      },
      flush(callback) {
        if (!firstLineSkipped && lineBuffer.length > 0) {
          callback(null, lineBuffer + '\n')
        } else {
          callback()
        }
      },
    })

    await pipeline(readStream, stripHeader, finalWrite, { end: false })
  }

  await new Promise<void>((resolve) => finalWrite.end(() => resolve()))
  const totalSizeBytes = finalWrite.bytesWritten
  return { totalSizeBytes }
}
