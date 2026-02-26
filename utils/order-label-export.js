const { call } = require('./api')
const { showErrorDialog, showResultError } = require('./error-feedback')

function cloudDownloadFile(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.downloadFile({
      fileID,
      success: resolve,
      fail: reject,
    })
  })
}

function openPdfDocument(filePath) {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      fileType: 'pdf',
      showMenu: true,
      success: resolve,
      fail: reject,
    })
  })
}

function buildFailResult(message, detail) {
  return { ok: false, message: String(message || '导出失败'), detail: detail || null }
}

function hideLoadingSafe() {
  try {
    wx.hideLoading()
  } catch (err) {}
}

async function exportAndOpenOrderLabelsPdf(payload = {}) {
  wx.showLoading({ title: '导出中...' })
  try {
    const res = await call('admin', 'exportOrderLabelsPdf', payload)
    if (!res.ok) {
      hideLoadingSafe()
      await showResultError(
        {
          ...res,
          detail: {
            action: 'admin.exportOrderLabelsPdf',
            payload,
            backendDetail: res.detail || '',
          },
        },
        '导出标签失败',
        { title: '导出标签失败' }
      )
      return buildFailResult(res.message || '导出失败', res.detail || null)
    }
    const data = (res && res.data) || {}
    const fileID = String(data.fileID || '').trim()
    if (!fileID) {
      hideLoadingSafe()
      await showErrorDialog(
        {
          message: '导出失败：缺少文件ID',
          code: 'MISSING_FILE_ID',
          detail: { action: 'admin.exportOrderLabelsPdf', payload, result: data },
        },
        { title: '导出标签失败' }
      )
      return buildFailResult('导出失败：缺少文件ID')
    }
    const dl = await cloudDownloadFile(fileID)
    const filePath = String((dl && (dl.tempFilePath || dl.filePath)) || '').trim()
    if (!filePath) {
      hideLoadingSafe()
      await showErrorDialog(
        {
          message: '下载PDF失败',
          code: 'DOWNLOAD_EMPTY_PATH',
          detail: { fileID, downloadResult: dl || null },
        },
        { title: '导出标签失败' }
      )
      return buildFailResult('下载PDF失败')
    }
    await openPdfDocument(filePath)
    const labelCount = Math.max(0, Number(data.labelCount) || 0)
    const pageCount = Math.max(0, Number(data.pageCount) || 0)
    hideLoadingSafe()
    wx.showToast({
      title: `已导出 ${labelCount} 单 / ${pageCount} 页`,
      icon: 'success',
    })
    return { ok: true, data }
  } catch (err) {
    const msg = String((err && (err.errMsg || err.message)) || '导出失败')
    hideLoadingSafe()
    await showErrorDialog(
      {
        message: msg,
        code: 'EXPORT_PDF_FLOW_FAILED',
        detail: { payload, error: err || null },
      },
      { title: '导出标签失败' }
    )
    return buildFailResult(msg, err || null)
  } finally {
    hideLoadingSafe()
  }
}

module.exports = {
  exportAndOpenOrderLabelsPdf,
}
