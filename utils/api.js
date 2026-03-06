function normalizeCloudError(err) {
  const msg = (err && (err.errMsg || err.message)) || 'Unknown error'
  return { ok: false, code: 'CLOUD_ERROR', message: msg, detail: err }
}

function isReadLikeAction(action) {
  const name = String(action || '').trim()
  if (!name) return false
  if (name.startsWith('getOrCreate')) return true
  if (name.startsWith('get')) return true
  if (name.startsWith('list')) return true
  if (name.startsWith('search')) return true
  if (name.startsWith('bootstrap')) return true
  if (name.startsWith('is')) return true
  if (name.startsWith('export')) return true
  return false
}

function shouldInvalidateSnapshotAfterCall(fnName, action) {
  const functionName = String(fnName || '').trim()
  if (!functionName || functionName === 'auth') return false
  return !isReadLikeAction(action)
}

function invalidateSnapshotSafely() {
  try {
    // Lazy require to avoid circular import issues with app-snapshot -> api.
    // eslint-disable-next-line global-require
    const { invalidateSnapshot } = require('./app-snapshot')
    invalidateSnapshot()
  } catch (err) {
    // ignore
  }
}

function refreshCurrentPageAfterWriteFailure() {
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const currentPage = pages && pages.length ? pages[pages.length - 1] : null
    if (!currentPage) return
    if (typeof currentPage.__scheduleWriteFailureSnapshotRefresh === 'function') {
      currentPage.__scheduleWriteFailureSnapshotRefresh()
      return
    }
    if (typeof currentPage.__refreshStartupSnapshotAfterWriteFailure !== 'function') return
    Promise.resolve().then(() => currentPage.__refreshStartupSnapshotAfterWriteFailure())
  } catch (err) {
    // ignore
  }
}

async function call(fnName, action, payload = {}) {
  const invalidateSnapshotAfterCall = shouldInvalidateSnapshotAfterCall(fnName, action)
  try {
    const res = await wx.cloud.callFunction({
      name: fnName,
      data: { action, ...payload },
    })
    const result = res && res.result
    const normalized = result || { ok: false, code: 'NO_RESULT', message: 'No result from cloud function' }
    if (invalidateSnapshotAfterCall) {
      invalidateSnapshotSafely()
      if (!normalized.ok) refreshCurrentPageAfterWriteFailure()
    }
    return normalized
  } catch (err) {
    const normalized = normalizeCloudError(err)
    if (invalidateSnapshotAfterCall) {
      invalidateSnapshotSafely()
      refreshCurrentPageAfterWriteFailure()
    }
    return normalized
  }
}

module.exports = {
  call,
}

