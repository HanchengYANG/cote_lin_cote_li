const { createOrderLabelExportDataService } = require('./order-label-export-data')
const { buildOrderLabelsPdfBuffer } = require('../lib/order-label-pdf')
const { uploadOrderLabelsPdf } = require('../lib/order-label-storage')

const MAX_LABELS = 200

function createBizError(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  return err
}

function normalizeSourceType(input) {
  const v = String(input || '').trim()
  if (v === 'sale') return 'sale'
  if (v === 'order') return 'order'
  return ''
}

function normalizeBool(input, fallback) {
  if (input === undefined) return !!fallback
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') return input !== 0
  const v = String(input || '').trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return !!fallback
}

function buildPdfTitle(sourceType, sourceId, labelCount) {
  const safeType = sourceType === 'order' ? 'Order Label' : 'Order Labels'
  return `${safeType} ${String(sourceId || '').trim()} (${Math.max(0, Number(labelCount) || 0)})`
}

function mapErrorToResult(err, fail) {
  const code = String((err && err.code) || '').trim()
  const message = String((err && err.message) || '').trim() || 'Export order labels failed'
  const detail = err && err.detail != null ? err.detail : String((err && err.stack) || '')
  if (code === 'BAD_REQUEST') return fail('BAD_REQUEST', message, detail)
  if (code === 'NOT_FOUND') return fail('NOT_FOUND', message, detail)
  if (code === 'NO_EXPORTABLE_ORDERS') return fail('NO_EXPORTABLE_ORDERS', message, detail)
  if (code === 'TOO_MANY_LABELS') return fail('TOO_MANY_LABELS', message, detail)
  if (code === 'FONT_LOAD_FAILED') return fail('FONT_LOAD_FAILED', message, detail)
  if (code === 'PDF_UPLOAD_FAILED') return fail('PDF_UPLOAD_FAILED', message, detail)
  if (code === 'PDFKIT_NOT_INSTALLED' || code === 'PDF_RENDER_FAILED') return fail('PDF_RENDER_FAILED', message, detail)
  return fail('PDF_RENDER_FAILED', 'Export order labels failed', detail || message)
}

function createOrderLabelExportService(deps) {
  const { ok, fail, cloud, getTempUrlMap } = deps
  const dataService = createOrderLabelExportDataService(deps)

  async function loadSource(event) {
    const sourceType = normalizeSourceType(event && event.sourceType)
    if (!sourceType) throw createBizError('BAD_REQUEST', 'Invalid sourceType')
    if (sourceType === 'sale') {
      const saleId = String((event && event.saleId) || '').trim()
      if (!saleId) throw createBizError('BAD_REQUEST', 'Missing saleId')
      const includeDelivery = normalizeBool(event && event.includeDelivery, true)
      const includePickup = normalizeBool(event && event.includePickup, true)
      if (!includeDelivery && !includePickup) {
        throw createBizError('BAD_REQUEST', 'No fulfillment types selected')
      }
      const loaded = await dataService.loadLabelOrdersBySale({ saleId, includeDelivery, includePickup })
      return { ...loaded, sourceType, sourceId: saleId }
    }
    const orderId = String((event && event.orderId) || '').trim()
    if (!orderId) throw createBizError('BAD_REQUEST', 'Missing orderId')
    const loaded = await dataService.loadLabelOrderById({ orderId })
    return { ...loaded, sourceType, sourceId: orderId }
  }

  return {
    async exportOrderLabelsPdf(event) {
      try {
        const loaded = await loadSource(event)
        const rawOrders = Array.isArray(loaded && loaded.orders) ? loaded.orders : []
        if (!rawOrders.length) return fail('NO_EXPORTABLE_ORDERS', 'No exportable orders')
        if (rawOrders.length > MAX_LABELS) {
          return fail('TOO_MANY_LABELS', `Too many labels: ${rawOrders.length} > ${MAX_LABELS}`)
        }

        const labels = dataService.toLabelDtos(rawOrders)
        if (!labels.length) return fail('NO_EXPORTABLE_ORDERS', 'No exportable orders')
        if (labels.length > MAX_LABELS) {
          return fail('TOO_MANY_LABELS', `Too many labels: ${labels.length} > ${MAX_LABELS}`)
        }
        const pdf = await buildOrderLabelsPdfBuffer({
          labels,
          title: buildPdfTitle(loaded.sourceType, loaded.sourceId, labels.length),
        })

        const generatedAtMs = Date.now()
        const uploaded = await uploadOrderLabelsPdf({
          cloud,
          getTempUrlMap,
          buffer: pdf.buffer,
          sourceType: loaded.sourceType,
          saleId: loaded.sourceType === 'sale' ? loaded.sourceId : '',
          orderId: loaded.sourceType === 'order' ? loaded.sourceId : '',
          generatedAtMs,
        })

        return ok({
          fileID: uploaded.fileID,
          tempFileURL: uploaded.tempFileURL,
          filename: uploaded.filename,
          labelCount: rawOrders.length,
          pageCount: pdf.pageCount,
          sourceType: loaded.sourceType,
          generatedAt: uploaded.generatedAt,
        })
      } catch (err) {
        return mapErrorToResult(err, fail)
      }
    },
  }
}

module.exports = {
  createOrderLabelExportService,
}
