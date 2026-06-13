import { JsonRepository } from './JsonRepository.js'
import type { ExportTask } from '../../shared/types.js'

export const exportTaskRepository = new JsonRepository<ExportTask>('export_tasks.json')
