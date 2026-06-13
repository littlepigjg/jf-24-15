import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExportFormat } from '../../../../shared/types.js'

export const DEFAULT_CHUNK_SIZE = 100
export const DEFAULT_CONCURRENCY = 3
export const MAX_RETRY_COUNT = 3

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const DATA_ROOT = path.resolve(__dirname, '..', '..', '..', 'data')
export const STORAGE_ROOT = path.join(DATA_ROOT, 'cloud_storage')
export const CHUNKS_DIR = path.join(STORAGE_ROOT, 'chunks')
export const FILES_DIR = path.join(STORAGE_ROOT, 'files')
export const TEMP_ROOT = path.join(STORAGE_ROOT, 'temp')

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function safeFilename(
  baseName: string,
  usedNames: Map<string, number>,
  ext: string,
): string {
  const safe = baseName.replace(/[<>:"/\\|?*]/g, '_')
  let filename = `${safe}.${ext}`
  const count = usedNames.get(filename) || 0
  if (count > 0) {
    filename = `${safe}_${count}.${ext}`
  }
  usedNames.set(filename, count + 1)
  return filename
}

export function chunkFilename(taskId: string, chunkIndex: number, format: ExportFormat): string {
  const ext = format === 'zip' ? 'bin' : 'csv'
  return `${taskId}.c${chunkIndex}.${ext}`
}

export function chunkTempDir(taskId: string): string {
  return path.join(TEMP_ROOT, taskId)
}

export function finalFilename(taskId: string, format: ExportFormat): string {
  const ext = format === 'zip' ? 'zip' : 'csv'
  return `export_${taskId}.${ext}`
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function computeChecksum(filePath: string): Promise<string> {
  const hash = crypto.createHash('md5')
  const stream = (await import('node:fs')).createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-'
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

export function formatSpeed(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return '-'
  if (speed < 1) return `${Math.round(speed * 100) / 100} 条/秒`
  if (speed < 1000) return `${Math.round(speed)} 条/秒`
  return `${(speed / 1000).toFixed(2)} K 条/秒`
}

export function resolveStoragePaths(): {
  chunks: string
  files: string
  temp: string
} {
  return {
    chunks: CHUNKS_DIR,
    files: FILES_DIR,
    temp: TEMP_ROOT,
  }
}
