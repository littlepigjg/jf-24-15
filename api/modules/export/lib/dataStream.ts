import { qrCodeRepository } from '../../../repositories/QrCodeRepository.js'
import { StatsService } from '../../../services/StatsService.js'
import type { QrCode, ScanRecord, ExportFormat } from '../../../../shared/types.js'

export async function* iterateQrCodesByIds(
  ids: string[],
  signal?: { aborted?: boolean; paused?: boolean },
): AsyncGenerator<QrCode, void, unknown> {
  for (let i = 0; i < ids.length; i++) {
    if (signal?.aborted || signal?.paused) return
    const qr = await qrCodeRepository.getById(ids[i])
    if (qr) yield qr
  }
}

export async function* iterateQrCodesAll(
  signal?: { aborted?: boolean; paused?: boolean },
): AsyncGenerator<QrCode, void, unknown> {
  const all = await qrCodeRepository.getAll()
  for (const qr of all) {
    if (signal?.aborted || signal?.paused) return
    yield qr
  }
}

export async function* iterateQrCodes(
  ids?: string[],
  signal?: { aborted?: boolean; paused?: boolean },
): AsyncGenerator<QrCode, void, unknown> {
  if (ids && ids.length > 0) {
    yield* iterateQrCodesByIds(ids, signal)
  } else {
    yield* iterateQrCodesAll(signal)
  }
}

export async function* iterateScanRecordsForQrCode(
  qrcodeId: string,
  pageSize = 10000,
  signal?: { aborted?: boolean; paused?: boolean },
): AsyncGenerator<ScanRecord, void, unknown> {
  let page = 1
  while (true) {
    if (signal?.aborted || signal?.paused) return
    const result = await StatsService.listScanRecords(page, pageSize, qrcodeId)
    for (const r of result.items) {
      yield r
    }
    if (page * pageSize >= result.total || result.items.length === 0) {
      break
    }
    page++
  }
}

export async function* iterateScanRecordsByQrCodes(
  qrcodes: AsyncGenerator<QrCode> | QrCode[],
  signal?: { aborted?: boolean; paused?: boolean },
): AsyncGenerator<ScanRecord, void, unknown> {
  for await (const qr of qrcodes) {
    if (signal?.aborted || signal?.paused) return
    yield* iterateScanRecordsForQrCode(qr.id, 10000, signal)
  }
}

export async function* iterateCsvRows(
  qrcodeIds: string[],
  format: ExportFormat,
  signal?: { aborted?: boolean; paused?: boolean },
): AsyncGenerator<string, void, unknown> {
  if (format === 'csv' || format === 'full') {
    yield* (async function* (): AsyncGenerator<string, void, unknown> {
      const { qrCodeToCsvRow } = await import('./csv.js')
      for await (const qr of iterateQrCodesByIds(qrcodeIds, signal)) {
        yield qrCodeToCsvRow(qr)
      }
    })()
  } else if (format === 'scans_csv') {
    yield* (async function* (): AsyncGenerator<string, void, unknown> {
      const { scanRecordToCsvRow } = await import('./csv.js')
      const qrs = iterateQrCodesByIds(qrcodeIds, signal)
      for await (const r of iterateScanRecordsByQrCodes(qrs, signal)) {
        yield scanRecordToCsvRow(r)
      }
    })()
  }
}
