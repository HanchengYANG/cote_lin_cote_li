function safeStringify(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    const parts = []
    if (value.message) parts.push(String(value.message))
    if (value.stack) parts.push(String(value.stack))
    return parts.join('\n')
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch (e) {
    try {
      return String(value)
    } catch (e2) {
      return ''
    }
  }
}

function buildErrorDialogContent(input, fallbackTitle) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const msg = String(input || fallbackTitle || '操作失败').trim() || '操作失败'
    return { message: msg, copyText: msg }
  }
  const message = String(input.message || fallbackTitle || '操作失败').trim() || '操作失败'
  const code = String(input.code || '').trim()
  const detailText = safeStringify(input.detail)
  const lines = [message]
  if (code) lines.push(`code: ${code}`)
  if (detailText) lines.push(detailText)
  const content = lines.join('\n')
  return { message: content, copyText: content }
}

function showErrorDialog(input, options = {}) {
  const title = String(options.title || '错误').trim() || '错误'
  const built = buildErrorDialogContent(input, options.fallbackMessage || '')
  const content = built.message
  const copyText = String(options.copyText || built.copyText || content || title)
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      showCancel: true,
      cancelText: '复制',
      confirmText: '关闭',
      success: (res) => {
        if (res && res.cancel) {
          wx.setClipboardData({
            data: copyText,
            complete: () => resolve(false),
          })
          return
        }
        resolve(true)
      },
      fail: () => resolve(false),
    })
  })
}

function showResultError(result, fallbackMessage, options = {}) {
  return showErrorDialog(result || fallbackMessage, {
    title: options.title || '错误',
    fallbackMessage,
  })
}

function installErrorToastInterceptor() {
  if (!wx || typeof wx.showToast !== 'function') return
  if (wx.__errorToastInterceptorInstalled) return
  const rawShowToast = wx.showToast.bind(wx)
  wx.__rawShowToast = rawShowToast
  wx.showToast = function patchedShowToast(opts) {
    const input = (typeof opts === 'string') ? { title: opts } : { ...(opts || {}) }
    if (input.__forceToast) {
      delete input.__forceToast
      return rawShowToast(input)
    }
    const icon = String(input.icon || 'success').trim()
    if (icon === 'none') {
      const title = String(input.title || '操作失败').trim() || '操作失败'
      const copyText = String(input.__copyText || title)
      delete input.__copyText
      return showErrorDialog(title, { copyText })
    }
    return rawShowToast(input)
  }
  wx.__errorToastInterceptorInstalled = true
}

module.exports = {
  showErrorDialog,
  showResultError,
  installErrorToastInterceptor,
}
