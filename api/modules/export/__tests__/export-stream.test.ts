import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  buildCsvHeaders,
  writeCsvChunk,
  mergeCsvChunks,
  qrCodeToCsvRow,
  headersLine,
} from '../lib/csv.js'
import {
  writeZipChunkFiles,
  mergeZipFiles,
  writeZipManifest,
  readZipManifest,
  verifyZipManifestIntegrity,
  cleanupTempDir,
  type ZipTempEntry,
} from '../lib/zip.js'
import { computeProgress, countProcessedItems, countCompletedChunks } from '../lib/progress.js'
import {
  buildChunkList,
  verifyChunkIntegrity,
} from '../lib/chunkProcessor.js'
import type { QrCode, ExportTask, ExportChunk, ExportTaskStatus } from '../../../../shared/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let passed = 0
let failed = 0

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ❌ ${msg}`)
    failed++
    throw new Error(msg)
  }
  passed++
}

function eq<T>(actual: T, expected: T, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    console.error(`  ❌ ${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`)
    failed++
    throw new Error(msg)
  }
  passed++
}

async function withTempDir(label: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `export-test-${label}-`))
  console.log(`\n=== ${label} (tmp=${dir}) ===`)
  try {
    await fn(dir)
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

function fakeQr(i: number): QrCode {
  return {
    id: `qr-${i}`,
    name: `二维码 ${i}`,
    type: i % 2 === 0 ? 'dynamic' : 'static',
    targetUrl: `https://example.com/page/${i}`,
    shortCode: `sh${1000 + i}`,
    size: 128,
    foreground: '#0F172A',
    background: '#FFFFFF',
    errorLevel: 'M',
    enabled: true,
    scanCount: i * 10,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
    updatedAt: new Date(Date.now() - i * 500).toISOString(),
  }
}

async function* toAsyncGen<T>(arr: T[]): AsyncGenerator<T, void, unknown> {
  for (const x of arr) yield x
}

async function testCsvStreaming(tempDir: string): Promise<void> {
  const qrcodes = Array.from({ length: 50 }, (_, i) => fakeQr(i))
  const chunkPath = path.join(tempDir, 'chunk0.csv')

  const rowGen = toAsyncGen(qrcodes.map(qrCodeToCsvRow))
  const { rowCount, sizeBytes } = await writeCsvChunk({
    outputPath: chunkPath,
    rowIterator: rowGen,
    format: 'csv',
    includeHeader: true,
  })

  eq(rowCount, 50, 'CSV chunk 应该写 50 行数据')
  assert(sizeBytes > 0, 'CSV 文件大小应大于 0')

  const content = await fs.readFile(chunkPath, 'utf-8')
  const lines = content.split('\n').filter((l) => l.trim().length > 0)
  eq(lines.length, 51, 'CSV 文件应该包含 1 行 header + 50 行数据')
  assert(lines[0].startsWith('ID,名称'), '首行应为 header')
  assert(lines[1].includes(`qr-0`), '第二行应该是第一个二维码的数据')

  const header = buildCsvHeaders('csv')
  eq(lines[0], headersLine(header), 'header 内容应与 buildCsvHeaders 一致')
}

async function testCsvMerge(tempDir: string): Promise<void> {
  const qrcodes1 = Array.from({ length: 3 }, (_, i) => fakeQr(i))
  const qrcodes2 = Array.from({ length: 3 }, (_, i) => fakeQr(i + 100))

  const path1 = path.join(tempDir, 'chunk0.csv')
  const path2 = path.join(tempDir, 'chunk1.csv')
  const outputPath = path.join(tempDir, 'merged.csv')

  await writeCsvChunk({
    outputPath: path1,
    rowIterator: toAsyncGen(qrcodes1.map(qrCodeToCsvRow)),
    format: 'csv',
    includeHeader: true,
  })
  await writeCsvChunk({
    outputPath: path2,
    rowIterator: toAsyncGen(qrcodes2.map(qrCodeToCsvRow)),
    format: 'csv',
    includeHeader: true,
  })

  const { totalSizeBytes } = await mergeCsvChunks({
    chunkPaths: [path1, path2],
    outputPath,
    format: 'csv',
  })

  assert(totalSizeBytes > 0, '合并文件应大于 0')
  const rawContent = await fs.readFile(outputPath, 'utf-8')
  const content = rawContent.startsWith('\uFEFF') ? rawContent.slice(1) : rawContent
  const lines = content.split('\n').filter((l) => l.trim().length > 0)

  eq(lines.length, 7, '合并后应为 1 个 BOM+header + 6 行数据')
  const headerCount = lines.filter((l) => l.startsWith('ID,名称')).length
  eq(headerCount, 1, '合并后 header 只能出现一次')

  assert(lines.some((l) => l.includes('qr-0')), '应包含第一个分片的数据')
  assert(lines.some((l) => l.includes('qr-100')), '应包含第二个分片的数据')
}

async function testZipChunkAndManifest(tempDir: string): Promise<void> {
  const qrcodes = Array.from({ length: 5 }, (_, i) => fakeQr(i))

  const { entries, totalSizeBytes, skippedCount } = await writeZipChunkFiles({
    taskId: 'test-task',
    chunkIndex: 0,
    tempDir,
    qrcodeIterator: toAsyncGen(qrcodes),
    prefix: 'qrcodes/',
  })

  eq(entries.length, 5, '应该生成 5 个 PNG 文件')
  eq(skippedCount, 0, '不应该有跳过的文件')
  assert(totalSizeBytes > 0, '总大小应该大于 0')

  for (const e of entries) {
    const stat = await fs.stat(e.filePath)
    assert(stat.size > 0, `文件 ${e.archivePath} 应该存在且非空`)
    assert(e.archivePath.startsWith('qrcodes/'), `archivePath 应该有前缀: ${e.archivePath}`)
  }

  const manifestPath = path.join(tempDir, 'manifest.json')
  await writeZipManifest({ manifestPath, entries })
  const readBack = await readZipManifest(manifestPath)
  eq(readBack.length, 5, '读回 manifest 应该有 5 条')

  const { ok } = await verifyZipManifestIntegrity(manifestPath)
  assert(ok, 'manifest 完整性校验应该通过')
}

async function testZipMergeDedup(tempDir: string): Promise<void> {
  const chunkDirA = path.join(tempDir, '00', 'chunk_0')
  const chunkDirB = path.join(tempDir, '01', 'chunk_1')
  await fs.mkdir(chunkDirA, { recursive: true })
  await fs.mkdir(chunkDirB, { recursive: true })

  const fakeA = path.join(chunkDirA, '0_test.png')
  const fakeB = path.join(chunkDirB, '0_test.png')
  await fs.writeFile(fakeA, 'aaaa')
  await fs.writeFile(fakeB, 'bbbb')

  const entries: ZipTempEntry[] = [
    { filePath: fakeA, archivePath: 'qrcodes/test.png', sizeBytes: 4 },
    { filePath: fakeB, archivePath: 'qrcodes/test.png', sizeBytes: 4 },
  ]

  const outPath = path.join(tempDir, 'merged.zip')
  const { entryCount } = await mergeZipFiles({
    allEntries: entries,
    outputPath: outPath,
    zipLevel: 0,
  })

  eq(entryCount, 2, '重名文件应被去重后保留两个')

  const stat = await fs.stat(outPath)
  assert(stat.size > 50, '生成的 ZIP 应该是有效的（至少有 ZIP header）')
}

async function testZipChunkCleanup(tempDir: string): Promise<void> {
  const qrcodes1 = Array.from({ length: 3 }, (_, i) => fakeQr(i))
  await writeZipChunkFiles({
    taskId: 'test-task',
    chunkIndex: 0,
    tempDir,
    qrcodeIterator: toAsyncGen(qrcodes1),
    prefix: 'qrcodes/',
  })

  const bucketDir = path.join(tempDir, '00', 'chunk_0')
  const afterFirst = await fs.readdir(bucketDir)
  eq(afterFirst.length, 3, '第一次处理后应有 3 个文件')

  const qrcodes2 = Array.from({ length: 2 }, (_, i) => fakeQr(i + 50))
  await writeZipChunkFiles({
    taskId: 'test-task',
    chunkIndex: 0,
    tempDir,
    qrcodeIterator: toAsyncGen(qrcodes2),
    prefix: 'qrcodes/',
  })

  const afterSecond = await fs.readdir(bucketDir)
  eq(afterSecond.length, 2, '第二次处理前应清空目录，只留下 2 个新文件')
}

function testProgressExcludesPauseTime(): void {
  const now = new Date()
  const chunks: ExportChunk[] = [
    {
      id: 'c0',
      taskId: 't1',
      index: 0,
      startIndex: 0,
      endIndex: 100,
      itemIds: [],
      status: 'completed',
      retryCount: 0,
      processingTimeMs: 5000,
    },
    {
      id: 'c1',
      taskId: 't1',
      index: 1,
      startIndex: 100,
      endIndex: 200,
      itemIds: [],
      status: 'completed',
      retryCount: 0,
      processingTimeMs: 5000,
    },
    {
      id: 'c2',
      taskId: 't1',
      index: 2,
      startIndex: 200,
      endIndex: 300,
      itemIds: [],
      status: 'pending',
      retryCount: 0,
    },
  ]

  const task: ExportTask = {
    id: 't1',
    name: 'test',
    format: 'csv',
    qrcodeIds: [],
    totalItems: 300,
    totalChunks: 3,
    chunkSize: 100,
    concurrency: 1,
    status: 'paused' as ExportTaskStatus,
    chunks,
    activeTimeMs: 10000,
    createdAt: new Date(now.getTime() - 1000 * 60 * 60).toISOString(),
    startedAt: new Date(now.getTime() - 1000 * 60 * 60).toISOString(),
    progress: {} as any,
  }

  const progress = computeProgress(task)
  eq(progress.processedItems, 200, '处理条目数应为 200')
  eq(progress.uploadedChunks, 2, '完成分片数应为 2')
  eq(progress.percentage, Math.round((200 / 300) * 10000) / 100, '进度百分比正确')

  eq(progress.activeElapsedSeconds, 10, 'activeElapsedSeconds 应该是 10 秒（只算 processingTimeMs）')
  assert(progress.elapsedSeconds >= 3600, 'elapsedSeconds 应该包含暂停时间（至少 1 小时）')

  const expectedSpeed = 200 / 10
  eq(progress.averageSpeed, Math.round(expectedSpeed * 100) / 100, '速度应该按 active 时间算：20 条/秒')

  const expectedRemaining = Math.ceil(100 / expectedSpeed)
  eq(progress.estimatedRemainingSeconds, expectedRemaining, '剩余时间应该按 active 速度估算')
}

function testChunkList(): void {
  const ids = Array.from({ length: 250 }, (_, i) => `qr-${i}`)
  const chunks = buildChunkList(250, 100, 'task-1', ids)

  eq(chunks.length, 3, '250 条 / 100 每片 = 3 片')
  eq(chunks[0].startIndex, 0, 'c0 起点')
  eq(chunks[0].endIndex, 100, 'c0 终点')
  eq(chunks[0].itemIds.length, 100, 'c0 有 100 个 id')
  eq(chunks[2].startIndex, 200, 'c2 起点')
  eq(chunks[2].endIndex, 250, 'c2 终点（不满）')
  eq(chunks[2].itemIds.length, 50, 'c2 有 50 个 id')
}

async function testVerifyChunkIntegrityCsv(tempDir: string): Promise<void> {
  const csvPath = path.join(tempDir, 'chunk.csv')
  await fs.writeFile(csvPath, 'a,b,c\n1,2,3\n')
  const crypto = await import('node:crypto')
  const checksum = crypto
    .createHash('md5')
    .update(await fs.readFile(csvPath))
    .digest('hex')

  const validChunk: ExportChunk = {
    id: 'c1',
    taskId: 't1',
    index: 0,
    startIndex: 0,
    endIndex: 10,
    itemIds: [],
    status: 'completed',
    retryCount: 0,
    filePath: csvPath,
    checksum,
  }
  assert(await verifyChunkIntegrity(validChunk), 'checksum 匹配时校验应该通过')

  await fs.writeFile(csvPath, 'corrupted!')
  assert(!(await verifyChunkIntegrity(validChunk)), 'checksum 不匹配时校验应该失败')
}

async function testCountHelpers(): Promise<void> {
  const chunks: ExportChunk[] = [
    { id: 'c0', taskId: 't1', index: 0, startIndex: 0, endIndex: 50, itemIds: [], status: 'completed', retryCount: 0 },
    { id: 'c1', taskId: 't1', index: 1, startIndex: 50, endIndex: 100, itemIds: [], status: 'completed', retryCount: 0 },
    { id: 'c2', taskId: 't1', index: 2, startIndex: 100, endIndex: 150, itemIds: [], status: 'pending', retryCount: 0 },
  ]
  eq(countCompletedChunks(chunks), 2, 'countCompletedChunks')
  eq(countProcessedItems(chunks), 100, 'countProcessedItems (50+50)')
}

async function main(): Promise<void> {
  console.log('开始导出模块流式处理测试...\n')

  await withTempDir('csv-streaming', testCsvStreaming)
  await withTempDir('csv-merge', testCsvMerge)
  await withTempDir('zip-chunk', testZipChunkAndManifest)
  await withTempDir('zip-dedup', testZipMergeDedup)
  await withTempDir('zip-cleanup', testZipChunkCleanup)
  await withTempDir('integrity', testVerifyChunkIntegrityCsv)

  console.log('\n=== progress 测试 ===')
  testProgressExcludesPauseTime()
  testChunkList()
  await testCountHelpers()

  console.log('\n' + '='.repeat(50))
  console.log(`测试完成：✅ 通过 ${passed}, ❌ 失败 ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('测试运行异常:', err)
  process.exit(1)
})
