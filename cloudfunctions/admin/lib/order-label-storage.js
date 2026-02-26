function createBizError(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  return err
}

function sanitizePathSegment(input, fallback = 'x') {
  const raw = String(input || '').trim()
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

function pad2(n) {
  return String(Math.max(0, Number(n) || 0)).padStart(2, '0')
}

function buildTimeParts(ms) {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return null
  return {
    year: d.getFullYear(),
    month: pad2(d.getMonth() + 1),
    day: pad2(d.getDate()),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  }
}

function buildFilename(input) {
  const sourceType = String((input && input.sourceType) || '').trim() === 'order' ? 'order' : 'sale'
  const ms = Number(input && input.generatedAtMs) || Date.now()
  const parts = buildTimeParts(ms) || buildTimeParts(Date.now())
  const stamp = `${parts.year}${parts.month}${parts.day}-${parts.hh}${parts.mm}${parts.ss}`
  const id = sourceType === 'order' ? sanitizePathSegment(input && input.orderId, 'order') : sanitizePathSegment(input && input.saleId, 'sale')
  if (sourceType === 'order') return `order-label-${id}-${stamp}.pdf`
  return `order-labels-sale-${id}-${stamp}.pdf`
}

function buildCloudPath(input) {
  const ms = Number(input && input.generatedAtMs) || Date.now()
  const parts = buildTimeParts(ms) || buildTimeParts(Date.now())
  const filename = buildFilename(input)
  return `exports/order-labels/${parts.year}/${parts.month}/${filename}`
}

async function uploadOrderLabelsPdf(input) {
  const { cloud, getTempUrlMap, buffer } = input || {}
  if (!cloud || typeof cloud.uploadFile !== 'function') {
    throw createBizError('PDF_UPLOAD_FAILED', 'cloud.uploadFile is unavailable')
  }
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw createBizError('PDF_UPLOAD_FAILED', 'Invalid pdf buffer')
  }
  const generatedAtMs = Number(input && input.generatedAtMs) || Date.now()
  const filename = buildFilename({ ...input, generatedAtMs })
  const cloudPath = buildCloudPath({ ...input, generatedAtMs })

  let fileID = ''
  try {
    const uploadRes = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer,
    })
    fileID = String((uploadRes && uploadRes.fileID) || '').trim()
    if (!fileID) throw new Error('Missing fileID')
  } catch (err) {
    throw createBizError('PDF_UPLOAD_FAILED', 'Upload pdf failed', String(err && err.message))
  }

  let tempFileURL = ''
  try {
    const map = await getTempUrlMap([fileID])
    tempFileURL = String((map && map.get && map.get(fileID)) || '').trim()
  } catch (err) {
    tempFileURL = ''
  }

  return {
    fileID,
    tempFileURL,
    filename,
    cloudPath,
    generatedAt: generatedAtMs,
  }
}

module.exports = {
  uploadOrderLabelsPdf,
}
