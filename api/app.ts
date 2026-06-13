import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import authRoutes from './routes/auth.js'
import qrcodesRoutes from './routes/qrcodes.js'
import statsRoutes from './routes/stats.js'
import batchRoutes from './routes/batch.js'
import exportRoutes from './routes/export.js'
import { RedirectService } from './services/RedirectService.js'
import { CloudStorageService } from './services/CloudStorageService.js'
import { ExportService } from './modules/export/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config()

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

app.get('/r/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await RedirectService.resolve(req.params.code, req)
    if (!result) {
      res.status(404).send('Not found or disabled')
      return
    }
    res.redirect(302, result.targetUrl)
  } catch (err) {
    next(err)
  }
})

app.use('/api/auth', authRoutes)
app.use('/api/qrcodes', qrcodesRoutes)
app.use('/api/stats', statsRoutes)
app.use('/api/batch', batchRoutes)
app.use('/api/export', exportRoutes)

app.get('/api/storage/files/:filename', (req: Request, res: Response) => {
  const { filename } = req.params
  const filesDir = CloudStorageService.getFilesDir()
  const filePath = path.join(filesDir, filename)

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ success: false, error: '文件不存在' })
    return
  }

  const ext = path.extname(filename).toLowerCase()
  if (ext === '.csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  } else if (ext === '.zip') {
    res.setHeader('Content-Type', 'application/zip')
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  const stream = fs.createReadStream(filePath)
  stream.pipe(res)
})

app.use(
  '/api/health',
  (req: Request, res: Response, next: NextFunction): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(error)
  res.status(500).json({
    success: false,
    error: 'Server internal error',
  })
})

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

void ExportService.recoverTasks()

export default app
