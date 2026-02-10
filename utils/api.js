function normalizeCloudError(err) {
  const msg = (err && (err.errMsg || err.message)) || 'Unknown error'
  return { ok: false, code: 'CLOUD_ERROR', message: msg, detail: err }
}

async function call(fnName, action, payload = {}) {
  try {
    const res = await wx.cloud.callFunction({
      name: fnName,
      data: { action, ...payload },
    })
    const result = res && res.result
    if (!result) return { ok: false, code: 'NO_RESULT', message: 'No result from cloud function' }
    return result
  } catch (err) {
    return normalizeCloudError(err)
  }
}

module.exports = {
  call,
}

