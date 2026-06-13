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

export const CloudStorageService = {
  async uploadChunk(taskId: string, chunkIndex: number, data: Buffer | string): Promise<{ success: boolean; chunkId: string; size: number }> {
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
    return `/api/storage/files/${filename}`
  },

  async fileExists(filename: string): Promise<boolean> {
    const filePath = path.join(FILES_DIR, filename)
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
