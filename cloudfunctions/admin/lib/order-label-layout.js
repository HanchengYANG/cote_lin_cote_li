const PT_PER_MM = 72 / 25.4

function mm(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n * PT_PER_MM : 0
}

const PAGE_A4 = {
  width: mm(297),
  height: mm(210),
}

const GRID = {
  cols: 3,
  rows: 2,
  cellsPerPage: 6,
  cellWidth: PAGE_A4.width / 3,
  cellHeight: PAGE_A4.height / 2,
}

const LABEL_INSET = mm(3.5)
const SECTION_GAP = mm(1)

const FULL_LAYOUT_SECTION_HEIGHTS_MM = {
  header: 8.5,
  customer: 11,
  slot: 6.5,
  address: 8,
  remark: 8,
  items: 36,
}

const FULL_LAYOUT_SECTION_KEYS = ['header', 'customer', 'slot', 'address', 'remark', 'items']
const FULL_LAYOUT_FOOTER_MIN_MM = 9

function insetRect(rect, inset) {
  const n = Number(inset) || 0
  return {
    x: Number(rect.x || 0) + n,
    y: Number(rect.y || 0) + n,
    width: Math.max(0, Number(rect.width || 0) - 2 * n),
    height: Math.max(0, Number(rect.height || 0) - 2 * n),
  }
}

function getGridCellRect(indexInPage) {
  const idx = Math.max(0, Number(indexInPage) || 0) % GRID.cellsPerPage
  const col = idx % GRID.cols
  const row = Math.floor(idx / GRID.cols)
  return {
    x: GRID.cellWidth * col,
    y: GRID.cellHeight * row,
    width: GRID.cellWidth,
    height: GRID.cellHeight,
    col,
    row,
  }
}

function buildLabelSections(cellRect, options = {}) {
  const content = insetRect(cellRect, LABEL_INSET)
  const variant = String((options && options.variant) || 'full').trim() || 'full'
  const sections = {
    cell: cellRect,
    content,
    variant,
  }

  function setSection(key, y, height) {
    sections[key] = {
      x: content.x,
      y,
      width: content.width,
      height: Math.max(0, Number(height) || 0),
    }
  }

  function getFullLayoutHeightsPt() {
    return {
      header: mm(FULL_LAYOUT_SECTION_HEIGHTS_MM.header),
      customer: mm(FULL_LAYOUT_SECTION_HEIGHTS_MM.customer),
      slot: mm(FULL_LAYOUT_SECTION_HEIGHTS_MM.slot),
      address: mm(FULL_LAYOUT_SECTION_HEIGHTS_MM.address),
      remark: mm(FULL_LAYOUT_SECTION_HEIGHTS_MM.remark),
      items: mm(FULL_LAYOUT_SECTION_HEIGHTS_MM.items),
    }
  }

  function getFullLayoutFooterHeight() {
    const heights = getFullLayoutHeightsPt()
    const sectionHeightsTotal = FULL_LAYOUT_SECTION_KEYS.reduce((sum, key) => sum + (Number(heights[key]) || 0), 0)
    const usedBeforeFooter = sectionHeightsTotal + SECTION_GAP * FULL_LAYOUT_SECTION_KEYS.length
    return Math.max(mm(FULL_LAYOUT_FOOTER_MIN_MM), Math.max(0, content.height - usedBeforeFooter))
  }

  function buildFull() {
    const heights = getFullLayoutHeightsPt()
    let cursorY = content.y
    for (let i = 0; i < FULL_LAYOUT_SECTION_KEYS.length; i += 1) {
      const key = FULL_LAYOUT_SECTION_KEYS[i]
      const h = heights[key]
      setSection(key, cursorY, h)
      cursorY += h + SECTION_GAP
    }
    setSection('footer', cursorY, getFullLayoutFooterHeight())
  }

  function buildContinuation(kind) {
    const headerH = mm(8.5)
    const footerMinH = kind === 'continuation_last' ? getFullLayoutFooterHeight() : 0
    const topY = content.y
    const bottomY = content.y + content.height

    setSection('header', topY, headerH)
    const afterHeaderY = topY + headerH
    const itemsStartY = afterHeaderY + SECTION_GAP

    // Hidden meta sections are kept as zero-height rects for render-time branching.
    setSection('customer', itemsStartY, 0)
    setSection('slot', itemsStartY, 0)
    setSection('address', itemsStartY, 0)
    setSection('remark', itemsStartY, 0)

    if (kind === 'continuation_middle') {
      setSection('items', itemsStartY, Math.max(0, bottomY - itemsStartY))
      setSection('footer', bottomY, 0)
      return
    }

    let footerY = Math.max(itemsStartY, bottomY - footerMinH)
    let itemsH = Math.max(0, footerY - itemsStartY)
    if (itemsH > 0) {
      itemsH = Math.max(0, itemsH - SECTION_GAP)
      footerY = itemsStartY + itemsH + SECTION_GAP
    }
    const footerH = Math.max(0, bottomY - footerY)

    setSection('items', itemsStartY, itemsH)
    setSection('footer', footerY, footerH)
  }

  if (variant === 'continuation_middle' || variant === 'continuation_last') {
    buildContinuation(variant)
  } else {
    buildFull()
  }

  return sections
}

function getPageCount(labelCount) {
  const total = Math.max(0, Number(labelCount) || 0)
  return total > 0 ? Math.ceil(total / GRID.cellsPerPage) : 0
}

module.exports = {
  mm,
  PAGE_A4,
  GRID,
  LABEL_INSET,
  SECTION_GAP,
  insetRect,
  getGridCellRect,
  buildLabelSections,
  getPageCount,
}
