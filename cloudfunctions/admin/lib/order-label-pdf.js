const fs = require('fs')
const path = require('path')
const { PAGE_A4, GRID, getGridCellRect, getPageCount } = require('./order-label-layout')
const { renderLabel } = require('./order-label-render')

function createBizError(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  return err
}

function requirePdfKit() {
  try {
    return require('pdfkit')
  } catch (err) {
    throw createBizError('PDFKIT_NOT_INSTALLED', 'pdfkit is not installed', String(err && err.message))
  }
}

function getFontPathCandidates(filename) {
  return [
    path.join(__dirname, '..', 'assets', 'fonts', filename),
    path.join(__dirname, '..', 'assets', 'fonts', 'static', filename),
  ]
}

function resolveExistingFontPath(filename) {
  const candidates = getFontPathCandidates(filename)
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch (err) {}
  }
  return ''
}

function registerPdfFonts(doc) {
  const notoRegularPath = resolveExistingFontPath('NotoSansSC-Regular.ttf')
  const notoBoldPath = resolveExistingFontPath('NotoSansSC-Bold.ttf')
  const fontPath = notoRegularPath
  const boldFontPath = notoBoldPath
  try {
    if (!fontPath || !boldFontPath) {
      throw createBizError('FONT_LOAD_FAILED', 'NotoSansSC font files not found', {
        required: ['NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf'],
        searchedRegular: getFontPathCandidates('NotoSansSC-Regular.ttf'),
        searchedBold: getFontPathCandidates('NotoSansSC-Bold.ttf'),
      })
    }
  } catch (err) {
    if (err && err.code) throw err
    throw createBizError('FONT_LOAD_FAILED', 'Failed to access Chinese font file', {
      fontPath,
      boldFontPath,
      error: String(err && err.message),
    })
  }

  try {
    // Use TTF files only to avoid PDFKit/fontkit TTC subset incompatibilities.
    doc.registerFont('zh', fontPath)
    doc.registerFont('zhBold', boldFontPath)
    // Preflight font embedding so failures happen before render loop starts.
    doc.font('zh')
    doc.font('zhBold')
    return {
      fontPath,
      boldFontPath,
      fontFamily: 'NotoSansSC',
    }
  } catch (err) {
    throw createBizError('FONT_LOAD_FAILED', 'Failed to register PDF fonts', {
      fontPath,
      boldFontPath,
      error: String(err && err.message),
    })
  }
}

function collectPdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', (err) => reject(err))
  })
}

function drawPageGrid(doc) {
  doc.save()
  doc.lineWidth(0.4)
  doc.strokeColor('#d0d5dd')
  doc.rect(0, 0, PAGE_A4.width, PAGE_A4.height).stroke()
  doc.moveTo(GRID.cellWidth, 0).lineTo(GRID.cellWidth, PAGE_A4.height).stroke()
  doc.moveTo(0, GRID.cellHeight).lineTo(PAGE_A4.width, GRID.cellHeight).stroke()
  doc.dash(2, { space: 2 })
  for (let i = 1; i < GRID.cols; i += 1) {
    doc.moveTo(GRID.cellWidth * i, 0).lineTo(GRID.cellWidth * i, PAGE_A4.height).stroke()
  }
  for (let i = 1; i < GRID.rows; i += 1) {
    doc.moveTo(0, GRID.cellHeight * i).lineTo(PAGE_A4.width, GRID.cellHeight * i).stroke()
  }
  doc.undash()
  doc.restore()
}

async function buildOrderLabelsPdfBuffer(input) {
  const labels = Array.isArray(input && input.labels) ? input.labels : []
  const title = String((input && input.title) || 'Order Labels').trim() || 'Order Labels'
  if (!labels.length) throw createBizError('NO_EXPORTABLE_ORDERS', 'No labels to export')

  const PDFDocument = requirePdfKit()
  const doc = new PDFDocument({
    autoFirstPage: false,
    margin: 0,
    info: {
      Title: title,
      Producer: 'cote_lin_cote_li/admin/order-label-export',
      Creator: 'OpenAI Codex',
    },
  })
  const bufferPromise = collectPdfBuffer(doc)

  let fontMeta = null
  try {
    fontMeta = registerPdfFonts(doc)

    for (let i = 0; i < labels.length; i += 1) {
      if (i % GRID.cellsPerPage === 0) {
        doc.addPage({
          size: [PAGE_A4.width, PAGE_A4.height],
          margin: 0,
        })
        drawPageGrid(doc)
      }
      renderLabel(doc, labels[i], getGridCellRect(i % GRID.cellsPerPage), {
        fonts: { regular: 'zh', bold: 'zhBold' },
      })
    }

    doc.end()
  } catch (err) {
    if (err && err.code) throw err
    throw createBizError('PDF_RENDER_FAILED', 'Render PDF failed', {
      stage: fontMeta ? 'render' : 'font-register',
      labelCount: labels.length,
      fontPath: fontMeta && fontMeta.fontPath,
      boldFontPath: fontMeta && fontMeta.boldFontPath,
      fontFamily: fontMeta && fontMeta.fontFamily,
      error: String(err && err.message),
    })
  }
  try {
    const buffer = await bufferPromise
    return {
      buffer,
      pageCount: getPageCount(labels.length),
      fontPath: fontMeta.fontPath,
    }
  } catch (err) {
    if (err && err.code) throw err
    throw createBizError('PDF_RENDER_FAILED', 'Render PDF failed', {
      stage: 'stream-finalize',
      labelCount: labels.length,
      fontPath: fontMeta && fontMeta.fontPath,
      boldFontPath: fontMeta && fontMeta.boldFontPath,
      fontFamily: fontMeta && fontMeta.fontFamily,
      error: String(err && err.message),
    })
  }
}

module.exports = {
  buildOrderLabelsPdfBuffer,
}
