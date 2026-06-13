import { Router, type Request, type Response } from 'express'
import { ExportController, ExportService } from '../modules/export/index.js'

const router = Router()

router.post('/', async (req: Request, res: Response): Promise<void> => {
  await ExportController.handleExport(req, res, 'body')
})

router.post('/tasks', async (req: Request, res: Response): Promise<void> => {
  await ExportController.createTask(req, res)
})

router.get('/tasks', async (req: Request, res: Response): Promise<void> => {
  await ExportController.listTasks(req, res)
})

router.get('/tasks/:id', async (req: Request, res: Response): Promise<void> => {
  await ExportController.getTask(req, res)
})

router.get('/tasks/:id/progress', async (req: Request, res: Response): Promise<void> => {
  await ExportController.getTaskProgress(req, res)
})

router.post('/tasks/:id/pause', async (req: Request, res: Response): Promise<void> => {
  await ExportController.pauseTask(req, res)
})

router.post('/tasks/:id/resume', async (req: Request, res: Response): Promise<void> => {
  await ExportController.resumeTask(req, res)
})

router.delete('/tasks/:id', async (req: Request, res: Response): Promise<void> => {
  await ExportController.deleteTask(req, res)
})

router.get('/qrcodes/png.zip', async (req: Request, res: Response): Promise<void> => {
  await ExportController.handleExport(req, res, 'query')
})

router.get('/stats.csv', async (req: Request, res: Response): Promise<void> => {
  await ExportController.handleExport(req, res, 'query')
})

router.get('/scans.csv', async (req: Request, res: Response): Promise<void> => {
  await ExportController.handleExport(req, res, 'query')
})

router.get('/full.zip', async (req: Request, res: Response): Promise<void> => {
  await ExportController.handleExport(req, res, 'query')
})

export { ExportService }
export default router
