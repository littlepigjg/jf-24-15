import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const STORAGE_DIR = path.resolve(__dirname, '..', 'data', 'cloud_storage')
const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks')
const FILES_DIR = path.join(STORAGE_DIR, 'files')

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export interface UploadChunkResult {
  success: boolean
  chunkId: string
  size: number
}

export interface MergeResult {
  success: boolean
  fileUrl: string
  totalSize: number
}

export const CloudStorageService = {
  async uploadChunk(taskId: string, chunkIndex: number, data: Buffer | string): Promise<UploadChunkResult> {
    await ensureDir(CHUNKS_DIR)
    const chunkId = `${taskId}_chunk_${chunkIndex}`
    const chunkPath = path.join(CHUNKS_DIR, chunkId)
    await fs.writeFile(chunkPath, data)
    const stats = await fs.stat(chunkPath)
    return {
      success: true,
      chunkId,
      size: stats.size,
    }
  },

  async getChunkUrl(taskId: string, chunkIndex: number): Promise<string> {
    const chunkId = `${taskId}_chunk_${chunkIndex}`
    return `/api/storage/chunks/${chunkId}`
  },

  async mergeChunks(taskId: string, totalChunks: number, filename: string): Promise<MergeResult> {
    await ensureDir(FILES_DIR)
    const finalPath = path.join(FILES_DIR, `${taskId}_${filename}`)
    let totalSize = 0

    const writeStream = (await import('node:fs')).createWriteStream(finalPath)

    for (let i = 0; i < totalChunks; i++) {
      const chunkId = `${taskId}_chunk_${i}`
      const chunkPath = path.join(CHUNKS_DIR, chunkId)
      const chunkData = await fs.readFile(chunkPath)
      totalSize += chunkData.length
      await new Promise<void>((resolve, reject) => {
        writeStream.write(chunkData, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }

    await new Promise<void>((resolve) => writeStream.end(() => resolve()))

    return {
      success: true,
      fileUrl: `/api/storage/files/${taskId}_${filename}`,
      totalSize,
    }
  },

  async deleteChunks(taskId: string, totalChunks: number): Promise<void> {
    for (let i = 0; i < totalChunks; i++) {
      const chunkId = `${taskId}_chunk_${i}`
      const chunkPath = path.join(CHUNKS_DIR, chunkId)
      try {
        await fs.unlink(chunkPath)
      } catch {
        // ignore
      }
    }
  },

  async getFileUrl(taskId: string, filename: string): Promise<string> {
    return `/api/storage/files/${taskId}_${filename}`
  },

  async fileExists(taskId: string, filename: string): Promise<boolean> {
    const filePath = path.join(FILES_DIR, `${taskId}_${filename}`)
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  },

  getStorageDir(): string {
    return STORAGE_DIR
  },

  getChunksDir(): string {
    return CHUNKS_DIR
  },

  getFilesDir(): string {
    return FILES_DIR
  },
}
