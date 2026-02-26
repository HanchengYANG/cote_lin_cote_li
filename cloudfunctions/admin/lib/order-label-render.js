const { buildLabelSections, insetRect, mm } = require('./order-label-layout')
const { normalizeText, truncateToWidth, wrapAndClamp, drawLines } = require('./order-label-text')

const STYLE = {
  color: {
    text: '#111111',
    subtext: '#2f2f2f',
    muted: '#666666',
    soft: '#555555',
    border: '#bdbdbd',
    grid: '#d9d9d9',
    headerBg: '#f7f7f7',
    headerBorder: '#8a8a8a',
    headerText: '#111111',
    leader: '#b8b8b8',
  },
  fontSize: {
    headerTag: 8.8,
    headerSeq: 7.0,
    headerOrderId: 7.6,
    sectionLabel: 6.3,
    customerName: 8.2,
    body: 7.4,
    bodySm: 7.2,
    bodyXs: 7.0,
    footerLabel: 6.2,
    footerValue: 7.6,
    footerStatus: 7.2,
    footerTime: 7.2,
  },
  lineHeight: {
    slot: 8.0,
    address: 8.6,
    remark: 8.0,
    items: 8.4,
  },
  items: {
    rowsByFragment: {
      single: 10,
      first: 10,
      middle: 14,
      last: 12,
    },
    qtyColWidth: 18,
    priceColWidth: 34,
    priceQtyGap: 4,
    minLeaderWidth: 10,
    leaderGap: 2,
    leaderChar: '·',
  },
}

function centToEuro(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return '0.00'
  return (Math.max(0, Math.round(n)) / 100).toFixed(2)
}

function fulfillmentLabel(label) {
  return String(label && label.fulfillmentType) === 'pickup' ? '自取' : '配送'
}

function paidStatusLabel(status) {
  return String(status || '') === 'PAID' ? '已收款' : '未收款'
}

function normalizeFragmentKind(input) {
  const kind = String(input || '').trim()
  if (kind === 'first' || kind === 'middle' || kind === 'last' || kind === 'single') return kind
  return 'single'
}

function sectionVariantForFragment(kind) {
  if (kind === 'middle') return 'continuation_middle'
  if (kind === 'last') return 'continuation_last'
  return 'full'
}

function itemRowLimitForFragment(kind) {
  const rowsByFragment = (STYLE.items && STYLE.items.rowsByFragment) || {}
  const n = Number(rowsByFragment[kind])
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  const fallback = Number(rowsByFragment.single)
  return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 5
}

function itemUnitPriceText(item) {
  const unitPriceCents = Math.max(0, Number(item && item.unitPriceCents) || 0)
  if (unitPriceCents > 0) return `€${centToEuro(unitPriceCents)}`
  const lineTotalCents = Math.max(0, Number(item && item.lineTotalCents) || 0)
  const qty = Math.max(0, Number(item && item.qty) || 0)
  if (lineTotalCents > 0 && qty > 0) return `€${centToEuro(Math.round(lineTotalCents / qty))}`
  return '€0.00'
}

function setTextStyle(doc, fontName, fontSize, color) {
  doc.font(fontName || 'Helvetica')
  doc.fontSize(Number(fontSize) || 10)
  doc.fillColor(color || STYLE.color.text)
}

function measureText(doc, text, options = {}) {
  setTextStyle(doc, options.fontName, options.fontSize, options.color)
  return doc.widthOfString(String(text == null ? '' : text))
}

function drawSingleLineText(doc, text, rect, options = {}) {
  const x = Number(rect && rect.x) || 0
  const y = Number(rect && rect.y) || 0
  const width = Math.max(0, Number(rect && rect.width) || 0)
  if (width <= 0) return ''
  const fontName = options.fontName || 'Helvetica'
  const fontSize = Number(options.fontSize) || 10
  const color = options.color || STYLE.color.text
  const align = options.align || 'left'
  const suffix = options.suffix === undefined ? '...' : String(options.suffix)

  setTextStyle(doc, fontName, fontSize, color)
  const raw = normalizeText(text, '').replace(/\n/g, ' ')
  const display = truncateToWidth(doc, raw, width, suffix)
  doc.text(display, x, y, {
    width,
    lineBreak: false,
    align,
  })
  return display
}

function drawMultiLineText(doc, text, rect, options = {}) {
  const width = Math.max(0, Number(rect && rect.width) || 0)
  if (width <= 0) return { lines: [], truncated: false }
  const fontName = options.fontName || 'Helvetica'
  const fontSize = Number(options.fontSize) || 8
  const lineHeight = Number(options.lineHeight) || fontSize * 1.25
  const maxLines = Math.max(1, Number(options.maxLines) || 1)
  const color = options.color || STYLE.color.text

  setTextStyle(doc, fontName, fontSize, color)
  const wrapped = wrapAndClamp(doc, normalizeText(text, ''), {
    maxWidth: width,
    maxLines,
  })
  drawLines(doc, wrapped.lines, rect, { lineHeight, color })
  return wrapped
}

function drawRectOutline(doc, rect, options = {}) {
  const radius = Number(options.radius) || 0
  doc.save()
  doc.lineWidth(Number(options.lineWidth) || 0.45)
  doc.strokeColor(options.strokeColor || STYLE.color.border)
  if (options.fillColor) doc.fillColor(options.fillColor)
  if (radius > 0) doc.roundedRect(rect.x, rect.y, rect.width, rect.height, radius)
  else doc.rect(rect.x, rect.y, rect.width, rect.height)
  if (options.fillColor) doc.fillAndStroke()
  else doc.stroke()
  doc.restore()
}

function drawSectionLabel(doc, title, rect, options = {}) {
  return drawSingleLineText(doc, title, rect, {
    fontName: options.fontName || 'Helvetica',
    fontSize: STYLE.fontSize.sectionLabel,
    color: STYLE.color.muted,
    suffix: '',
  })
}

function buildLeaderDots(doc, width, options = {}) {
  const w = Math.max(0, Number(width) || 0)
  if (w <= 0) return ''
  const fontName = options.fontName || 'Helvetica'
  const fontSize = Number(options.fontSize) || STYLE.fontSize.bodySm
  const dotChar = String(options.dotChar || STYLE.items.leaderChar)
  setTextStyle(doc, fontName, fontSize, options.color || STYLE.color.leader)
  const unitWidth = doc.widthOfString(dotChar)
  if (!Number.isFinite(unitWidth) || unitWidth <= 0) return ''
  const repeatCount = Math.max(1, Math.ceil(w / unitWidth) + 2)
  return truncateToWidth(doc, dotChar.repeat(repeatCount), w, '')
}

function drawItemLineWithLeader(doc, dishName, qtyText, priceText, rect, options = {}) {
  const x = Number(rect && rect.x) || 0
  const y = Number(rect && rect.y) || 0
  const width = Math.max(0, Number(rect && rect.width) || 0)
  if (width <= 0) return

  const fonts = options.fonts || { regular: 'Helvetica', bold: 'Helvetica-Bold' }
  const fontSize = Number(options.fontSize) || STYLE.fontSize.bodySm
  const nameColor = options.nameColor || STYLE.color.text
  const qtyColor = options.qtyColor || STYLE.color.subtext
  const priceColor = options.priceColor || STYLE.color.soft
  const leaderColor = options.leaderColor || STYLE.color.leader
  const qtyColWidth = Math.max(12, Number(options.qtyColWidth) || STYLE.items.qtyColWidth)
  const priceColWidth = Math.max(24, Number(options.priceColWidth) || STYLE.items.priceColWidth)
  const priceQtyGap = Math.max(0, Number(options.priceQtyGap) || STYLE.items.priceQtyGap)
  const leaderGap = Math.max(0, Number(options.leaderGap) || STYLE.items.leaderGap)
  const minLeaderWidth = Math.max(0, Number(options.minLeaderWidth) || STYLE.items.minLeaderWidth)
  const normalizedPriceText = String(priceText || '').trim()
  const qtyRect = { x: x + Math.max(0, width - qtyColWidth), y, width: Math.min(qtyColWidth, width) }
  let leftStopX = qtyRect.x
  let priceRect = { x: qtyRect.x, y, width: 0 }

  if (normalizedPriceText) {
    const priceMaxWidth = Math.max(0, width - qtyRect.width - priceQtyGap)
    const priceW = Math.max(0, Math.min(priceColWidth, priceMaxWidth))
    const priceX = Math.max(x, qtyRect.x - priceQtyGap - priceW)
    priceRect = {
      x: priceX,
      y,
      width: Math.max(0, qtyRect.x - priceQtyGap - priceX),
    }
    leftStopX = priceRect.x
  }

  const leftWidth = Math.max(0, leftStopX - x)

  drawSingleLineText(doc, qtyText, qtyRect, {
    fontName: fonts.regular,
    fontSize,
    color: qtyColor,
    align: 'right',
  })

  if (priceRect.width > 0 && normalizedPriceText) {
    drawSingleLineText(doc, normalizedPriceText, priceRect, {
      fontName: fonts.regular,
      fontSize,
      color: priceColor,
      align: 'right',
      suffix: '',
    })
  }

  const nameMaxWidth = Math.max(0, leftWidth - leaderGap - minLeaderWidth)
  const displayedName = drawSingleLineText(doc, dishName, { x, y, width: nameMaxWidth }, {
    fontName: fonts.regular,
    fontSize,
    color: nameColor,
    align: 'left',
  })

  const nameWidth = measureText(doc, displayedName, {
    fontName: fonts.regular,
    fontSize,
    color: nameColor,
  })

  const leaderX = x + Math.min(nameWidth + leaderGap, leftWidth)
  const leaderWidth = Math.max(0, leftStopX - leaderGap - leaderX)
  if (leaderWidth <= 1) return

  const dots = buildLeaderDots(doc, leaderWidth, {
    fontName: fonts.regular,
    fontSize,
    color: leaderColor,
  })
  if (!dots) return

  drawSingleLineText(doc, dots, { x: leaderX, y, width: leaderWidth }, {
    fontName: fonts.regular,
    fontSize,
    color: leaderColor,
    suffix: '',
  })
}

function drawFooterGrid(doc, label, rect, options = {}) {
  const fonts = options.fonts || { regular: 'Helvetica', bold: 'Helvetica-Bold' }
  const mode = String((options && options.mode) || 'full').trim() || 'full'
  drawRectOutline(doc, rect, { strokeColor: '#d8d8d8', radius: 3, lineWidth: 0.4 })

  const inner = insetRect(rect, mm(1))
  const colGap = 4
  const colWidth = Math.max(0, (inner.width - colGap) / 2)
  const x1 = inner.x
  const x2 = inner.x + colWidth + colGap
  const y1 = inner.y
  const row1H = Math.max(11.5, Math.min(15, inner.height * 0.52))
  const y2 = y1 + row1H
  const row2H = Math.max(10, inner.height - row1H)

  doc.save()
  doc.lineWidth(0.35).strokeColor(STYLE.color.grid)
  doc.moveTo(inner.x, y2).lineTo(inner.x + inner.width, y2).stroke()
  doc.moveTo(x2 - colGap / 2, inner.y).lineTo(x2 - colGap / 2, inner.y + inner.height).stroke()
  doc.restore()

  if (mode === 'frame_only') {
    return { inner, row1H, row2H, mode }
  }

  const row1LabelWidth = 16
  const row2LeftLabelWidth = 16
  const row2RightLabelWidth = 28

  drawSingleLineText(doc, '件数', { x: x1, y: y1 + 1, width: row1LabelWidth }, {
    fontName: fonts.regular,
    fontSize: STYLE.fontSize.footerLabel,
    color: STYLE.color.muted,
    suffix: '',
  })
  drawSingleLineText(doc, '金额', { x: x2, y: y1 + 1, width: row1LabelWidth }, {
    fontName: fonts.regular,
    fontSize: STYLE.fontSize.footerLabel,
    color: STYLE.color.muted,
    suffix: '',
  })
  drawSingleLineText(doc, String(Math.max(0, Number(label && label.totalsQty) || 0)), {
    x: x1 + row1LabelWidth,
    y: y1 + 0.2,
    width: Math.max(0, colWidth - row1LabelWidth),
  }, {
    fontName: fonts.bold,
    fontSize: STYLE.fontSize.footerValue,
    color: STYLE.color.text,
    align: 'right',
  })
  drawSingleLineText(doc, `€ ${centToEuro(label && label.totalsAmountCents)}`, {
    x: x2 + row1LabelWidth,
    y: y1 + 0.2,
    width: Math.max(0, colWidth - row1LabelWidth),
  }, {
    fontName: fonts.bold,
    fontSize: STYLE.fontSize.footerValue,
    color: STYLE.color.text,
    align: 'right',
  })

  drawSingleLineText(doc, '收款', { x: x1, y: y2 + 0.9, width: row2LeftLabelWidth }, {
    fontName: fonts.regular,
    fontSize: STYLE.fontSize.footerLabel,
    color: STYLE.color.muted,
    suffix: '',
  })
  drawSingleLineText(doc, paidStatusLabel(label && label.paidStatus), {
    x: x1 + row2LeftLabelWidth,
    y: y2 + 0.2,
    width: Math.max(0, colWidth - row2LeftLabelWidth),
  }, {
    fontName: fonts.bold,
    fontSize: STYLE.fontSize.footerStatus,
    color: STYLE.color.subtext,
    align: 'right',
  })

  drawSingleLineText(doc, '下单时间', { x: x2, y: y2 + 0.9, width: row2RightLabelWidth }, {
    fontName: fonts.regular,
    fontSize: STYLE.fontSize.footerLabel,
    color: STYLE.color.muted,
    suffix: '',
  })
  drawSingleLineText(doc, String((label && label.createdAtLabel) || ''), {
    x: x2 + row2RightLabelWidth,
    y: y2 + 0.2,
    width: Math.max(0, colWidth - row2RightLabelWidth),
  }, {
    fontName: fonts.bold,
    fontSize: STYLE.fontSize.footerTime,
    color: STYLE.color.soft,
    align: 'right',
  })

  return { inner, row1H, row2H, mode }
}

function renderLabel(doc, label, cellRect, options = {}) {
  const fonts = options.fonts || { regular: 'Helvetica', bold: 'Helvetica-Bold' }
  const fragmentKind = normalizeFragmentKind(label && label.fragmentKind)
  const sectionVariant = sectionVariantForFragment(fragmentKind)
  const sections = buildLabelSections(cellRect, { variant: sectionVariant })
  const showMetaBlocks = fragmentKind === 'single' || fragmentKind === 'first'
  const showFooter = fragmentKind !== 'middle'
  const footerMode = fragmentKind === 'first' ? 'frame_only' : 'full'

  drawRectOutline(doc, sections.content, { strokeColor: STYLE.color.border, radius: 3 })
  drawRectOutline(doc, sections.header, {
    strokeColor: STYLE.color.headerBorder,
    fillColor: STYLE.color.headerBg,
    radius: 3,
  })

  const headerInner = insetRect(sections.header, mm(1.5))
  drawSingleLineText(doc, fulfillmentLabel(label), {
    x: headerInner.x,
    y: headerInner.y + 0.2,
    width: headerInner.width * 0.2,
  }, {
    fontName: fonts.bold,
    fontSize: STYLE.fontSize.headerTag,
    color: STYLE.color.headerText,
    suffix: '',
  })
  drawSingleLineText(doc, `${Math.max(1, Number(label && label.seqNo) || 1)}/${Math.max(1, Number(label && label.seqTotal) || 1)}`, {
    x: headerInner.x + headerInner.width * 0.22,
    y: headerInner.y + 0.7,
    width: headerInner.width * 0.14,
  }, {
    fontName: fonts.regular,
    fontSize: STYLE.fontSize.headerSeq,
    color: STYLE.color.subtext,
    align: 'left',
  })
  drawSingleLineText(doc, String((label && label.orderId) || ''), {
    x: headerInner.x + headerInner.width * 0.36,
    y: headerInner.y + 0.5,
    width: headerInner.width * 0.64,
  }, {
    fontName: fonts.bold,
    fontSize: STYLE.fontSize.headerOrderId,
    color: STYLE.color.text,
    align: 'right',
  })

  if (showMetaBlocks) {
    const customerRect = insetRect(sections.customer, mm(1))
    drawSectionLabel(doc, '客户 / 电话', {
      x: customerRect.x,
      y: customerRect.y,
      width: customerRect.width,
      height: mm(2.4),
    }, { fontName: fonts.regular })
    drawSingleLineText(doc, String((label && label.customerNickname) || '匿名客户'), {
      x: customerRect.x,
      y: customerRect.y + mm(2.8),
      width: customerRect.width,
    }, {
      fontName: fonts.bold,
      fontSize: STYLE.fontSize.customerName,
      color: STYLE.color.text,
    })
    drawSingleLineText(doc, String((label && label.phone) || '-'), {
      x: customerRect.x,
      y: customerRect.y + mm(6.6),
      width: customerRect.width,
    }, {
      fontName: fonts.regular,
      fontSize: STYLE.fontSize.bodySm,
      color: STYLE.color.subtext,
    })

    const slotRect = insetRect(sections.slot, mm(1))
    drawSectionLabel(doc, '配送', {
      x: slotRect.x,
      y: slotRect.y,
      width: slotRect.width,
      height: mm(2.2),
    }, { fontName: fonts.regular })
    drawSingleLineText(doc, label && label.isPickup
      ? '自取（无需配送地址）'
      : String((label && label.deliveryTimeSlotLabel) || '').trim() || '配送时间段未设置', {
      x: slotRect.x,
      y: slotRect.y + mm(2.7),
      width: slotRect.width,
    }, {
      fontName: fonts.regular,
      fontSize: STYLE.fontSize.bodyXs,
      color: STYLE.color.subtext,
    })

    const addressRect = insetRect(sections.address, mm(1))
    drawSectionLabel(doc, '地址', {
      x: addressRect.x,
      y: addressRect.y,
      width: addressRect.width,
      height: mm(2.2),
    }, { fontName: fonts.regular })
    drawMultiLineText(
      doc,
      label && label.isPickup ? '自取（无需配送地址）' : String((label && label.addressText) || '').trim() || '地址未填写',
      {
        x: addressRect.x,
        y: addressRect.y + mm(2.8),
        width: addressRect.width,
        height: Math.max(0, addressRect.height - mm(2.8)),
      },
      {
        fontName: fonts.regular,
        fontSize: STYLE.fontSize.body,
        maxLines: 2,
        color: STYLE.color.text,
        lineHeight: STYLE.lineHeight.address,
      }
    )

    const remarkRect = insetRect(sections.remark, mm(1))
    drawSectionLabel(doc, '备注', {
      x: remarkRect.x,
      y: remarkRect.y,
      width: remarkRect.width,
      height: mm(1.8),
    }, { fontName: fonts.regular })
    drawMultiLineText(doc, String((label && label.remark) || '').trim() || '无备注', {
      x: remarkRect.x,
      y: remarkRect.y + mm(2.0),
      width: remarkRect.width,
      height: Math.max(0, remarkRect.height - mm(2.0)),
    }, {
      fontName: fonts.regular,
      fontSize: STYLE.fontSize.bodyXs,
      maxLines: 1,
      color: STYLE.color.subtext,
      lineHeight: 7.2,
    })
  }

  const itemsRect = insetRect(sections.items, mm(1))
  drawSectionLabel(doc, '菜品明细', {
    x: itemsRect.x,
    y: itemsRect.y,
    width: itemsRect.width,
    height: mm(2.2),
  }, { fontName: fonts.regular })

  const itemsBodyRect = {
    x: itemsRect.x,
    y: itemsRect.y + mm(2.7),
    width: itemsRect.width,
    height: Math.max(0, itemsRect.height - mm(2.7)),
  }
  const lineHeight = STYLE.lineHeight.items
  const maxRowsByHeight = Math.max(0, Math.floor((itemsBodyRect.height + 0.1) / lineHeight))
  const maxRows = Math.min(itemRowLimitForFragment(fragmentKind), maxRowsByHeight)
  const allItems = Array.isArray(label && label.items) ? label.items : []

  if (!allItems.length) {
    drawSingleLineText(doc, '无菜品', {
      x: itemsBodyRect.x,
      y: itemsBodyRect.y,
      width: itemsBodyRect.width,
    }, {
      fontName: fonts.regular,
      fontSize: STYLE.fontSize.bodySm,
      color: STYLE.color.text,
    })
  } else if (maxRows <= 0) {
    // Nothing fits in the compact layout; fail soft by skipping items text.
  } else {
    let hiddenCount = 0
    const rows = []
    for (let i = 0; i < allItems.length; i += 1) {
      if (rows.length >= maxRows) {
        hiddenCount += 1
        continue
      }
      rows.push(allItems[i])
    }

    for (let i = 0; i < rows.length; i += 1) {
      const y = itemsBodyRect.y + i * lineHeight
      if (hiddenCount > 0 && i === rows.length - 1 && allItems.length > rows.length) {
        const hiddenTotal = hiddenCount + 1
        drawSingleLineText(doc, `其余 ${hiddenTotal} 项...`, {
          x: itemsBodyRect.x,
          y,
          width: itemsBodyRect.width,
        }, {
          fontName: fonts.regular,
          fontSize: STYLE.fontSize.bodyXs,
          color: STYLE.color.muted,
          suffix: '',
        })
        continue
      }

      const item = rows[i] || {}
      const dishName = normalizeText(item && item.dishName, '未知菜品')
      const qty = Math.max(0, Number(item && item.qty) || 0)
      drawItemLineWithLeader(doc, dishName, `x${qty}`, itemUnitPriceText(item), {
        x: itemsBodyRect.x,
        y,
        width: itemsBodyRect.width,
      }, {
        fonts,
        fontSize: STYLE.fontSize.bodySm,
        qtyColWidth: Math.max(STYLE.items.qtyColWidth, Math.min(20, itemsBodyRect.width * 0.12)),
        priceColWidth: Math.max(STYLE.items.priceColWidth, Math.min(42, itemsBodyRect.width * 0.22)),
        priceQtyGap: STYLE.items.priceQtyGap,
        nameColor: STYLE.color.text,
        qtyColor: STYLE.color.subtext,
        priceColor: STYLE.color.soft,
        leaderColor: STYLE.color.leader,
      })
    }
  }

  if (showFooter && Number(sections.footer && sections.footer.height) > 0) {
    const footerRect = insetRect(sections.footer, mm(1))
    drawFooterGrid(doc, label, footerRect, {
      fonts,
      mode: footerMode,
    })
  }
}

module.exports = {
  renderLabel,
}
