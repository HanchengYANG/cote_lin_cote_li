function createBizError(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  return err
}

function toSafeInt(input, fallback = 0) {
  const n = Number(input)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

function normalizeFulfillmentType(input) {
  return String(input || '').trim() === 'pickup' ? 'pickup' : 'delivery'
}

function toDateValue(input) {
  if (!input) return null
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input : null
  if (typeof input === 'object' && typeof input.toDate === 'function') {
    try {
      const d = input.toDate()
      if (d instanceof Date && Number.isFinite(d.getTime())) return d
    } catch (err) {}
  }
  if (typeof input === 'object' && input.$date) {
    const d = new Date(input.$date)
    if (Number.isFinite(d.getTime())) return d
  }
  const d = new Date(input)
  return Number.isFinite(d.getTime()) ? d : null
}

function formatDateTimeLabel(input) {
  const d = toDateValue(input)
  if (!d) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

function computeTotalsFromItems(items) {
  let qty = 0
  let amountCents = 0
  for (const it of Array.isArray(items) ? items : []) {
    const lineQty = Math.max(0, toSafeInt(it && it.qty, 0))
    const unitPriceCents = toSafeInt(it && (it.unitPriceCents != null ? it.unitPriceCents : it.priceCents), 0)
    const lineTotalCents = toSafeInt(it && it.lineTotalCents, unitPriceCents * lineQty)
    qty += lineQty
    amountCents += lineTotalCents
  }
  return { qty, amountCents }
}

function normalizeLabelItems(orderItems) {
  return (Array.isArray(orderItems) ? orderItems : [])
    .map((it) => ({
      dishId: String((it && it.dishId) || '').trim(),
      dishName: String((it && it.dishName) || '').trim() || '未知菜品',
      qty: Math.max(0, toSafeInt(it && it.qty, 0)),
      unitPriceCents: toSafeInt(it && (it.unitPriceCents != null ? it.unitPriceCents : it.priceCents), 0),
      lineTotalCents: it && it.lineTotalCents,
    }))
    .filter((it) => it.qty > 0 || it.dishName)
    .map((it) => ({
      ...it,
      lineTotalCents: Math.max(0, toSafeInt(it.lineTotalCents, it.qty * it.unitPriceCents)),
    }))
}

const LABEL_FRAGMENT_ITEM_ROWS = {
  single: 10,
  first: 10,
  middle: 14,
  last: 12,
}

function normalizePositiveCount(input, fallback) {
  const n = toSafeInt(input, fallback)
  return n > 0 ? n : Math.max(1, toSafeInt(fallback, 1))
}

function splitOrderItemsForLabels(items, capacities = {}) {
  const src = Array.isArray(items) ? items.slice() : []
  const singleCap = normalizePositiveCount(capacities.single, LABEL_FRAGMENT_ITEM_ROWS.single)
  const firstCap = normalizePositiveCount(capacities.first, LABEL_FRAGMENT_ITEM_ROWS.first)
  const middleCap = normalizePositiveCount(capacities.middle, LABEL_FRAGMENT_ITEM_ROWS.middle)
  const lastCap = normalizePositiveCount(capacities.last, LABEL_FRAGMENT_ITEM_ROWS.last)

  if (!src.length) return [{ kind: 'single', items: [] }]
  if (src.length <= singleCap) return [{ kind: 'single', items: src }]

  const out = []
  let cursor = 0
  const firstTake = Math.min(src.length, firstCap)
  if (firstTake <= 0) return [{ kind: 'single', items: src }]
  out.push({ kind: 'first', items: src.slice(cursor, cursor + firstTake) })
  cursor += firstTake

  if (cursor >= src.length) return [{ kind: 'single', items: src }]

  while (src.length - cursor > lastCap) {
    const remaining = src.length - cursor
    let take = Math.min(middleCap, remaining - lastCap)
    if (take <= 0) take = Math.min(middleCap, remaining)
    if (take <= 0) break
    out.push({ kind: 'middle', items: src.slice(cursor, cursor + take) })
    cursor += take
  }

  const tail = src.slice(cursor)
  if (tail.length) out.push({ kind: 'last', items: tail })

  if (out.length === 1) return [{ kind: 'single', items: src }]
  return out
}

function buildAddressText(order) {
  const fulfillmentType = normalizeFulfillmentType(order && order.fulfillmentType)
  if (fulfillmentType !== 'delivery') return ''
  const rawAddressText = String((order && order.addressText) || '').trim()
  return rawAddressText ? stripTrailingCountryLabel(rawAddressText) : ''
}

function buildCustomerNickname(order) {
  return String((order && order.customerNickname) || '').trim() || '匿名客户'
}

function stripTrailingCountryLabel(input) {
  const text = String(input || '').trim()
  if (!text) return ''
  // We only serve domestic addresses here; remove redundant trailing country labels in PDF output.
  return text
    .replace(/[,\s]+(?:FR|FRA|FRANCE|法国)$/i, '')
    .trim()
}

function formatFrenchPhoneLabel(inputDigits) {
  const raw = String(inputDigits || '').replace(/\D/g, '').trim()
  if (!raw) return ''
  let digits = raw
  if (digits.startsWith('0033')) {
    digits = `0${digits.slice(4)}`
  } else if (digits.startsWith('33') && digits.length === 11) {
    digits = `0${digits.slice(2)}`
  }
  if (!/^\d{10}$/.test(digits)) return raw
  return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim()
}

function formatAddressText(row) {
  if (!row) return ''
  return [row.line1, row.line2, row.postalCode, row.city, row.country].filter(Boolean).join(' ')
}

function toLabelDto(order, seqMeta, deps) {
  const { normalizePhone } = deps
  const items = normalizeLabelItems(order && order.items)
  const totalsRaw = (order && order.totals) || {}
  const computedTotals = computeTotalsFromItems(items)
  const totalsQty = Math.max(0, toSafeInt(totalsRaw.qty, computedTotals.qty || 0))
  const totalsAmountCents = Math.max(0, toSafeInt(totalsRaw.amountCents, computedTotals.amountCents || 0))
  const fulfillmentType = normalizeFulfillmentType(order && order.fulfillmentType)
  return {
    orderId: String((order && order._id) || ''),
    saleId: String((order && order.saleId) || ''),
    createdAt: (order && order.createdAt) || null,
    createdAtLabel: formatDateTimeLabel(order && order.createdAt),
    seqNo: Math.max(1, toSafeInt(seqMeta && seqMeta.seqNo, 1)),
    seqTotal: Math.max(1, toSafeInt(seqMeta && seqMeta.seqTotal, 1)),
    fragmentIndex: Math.max(1, toSafeInt(seqMeta && seqMeta.fragmentIndex, 1)),
    fragmentTotal: Math.max(1, toSafeInt(seqMeta && seqMeta.fragmentTotal, 1)),
    fragmentKind: String((seqMeta && seqMeta.fragmentKind) || 'single').trim() || 'single',
    fulfillmentType,
    customerNickname: buildCustomerNickname(order),
    phone: formatFrenchPhoneLabel(normalizePhone(order && order.contact && order.contact.phone)),
    deliveryTimeSlotLabel: String((order && order.deliveryTimeSlotLabelSnapshot) || '').trim(),
    addressText: buildAddressText(order),
    remark: String((order && order.remark) || '').trim(),
    items: items.map((it) => ({
      dishName: it.dishName,
      qty: it.qty,
      unitPriceCents: it.unitPriceCents,
      lineTotalCents: it.lineTotalCents,
    })),
    totalsQty,
    totalsAmountCents,
    paidStatus: String((order && order.payment && order.payment.paidStatus) || '').trim() === 'PAID' ? 'PAID' : 'UNPAID',
    handoffStatus: String((order && order.handoffStatus) || '').trim() === 'DELIVERED' ? 'DELIVERED' : 'PENDING',
    status: String((order && order.status) || '').trim(),
    isDelivery: fulfillmentType === 'delivery',
    isPickup: fulfillmentType === 'pickup',
  }
}

function expandOrderToLabelFragments(order, deps) {
  const base = toLabelDto(order, {
    seqNo: 1,
    seqTotal: 1,
    fragmentIndex: 1,
    fragmentTotal: 1,
    fragmentKind: 'single',
  }, deps)

  const fragments = splitOrderItemsForLabels(base.items, LABEL_FRAGMENT_ITEM_ROWS)
  if (fragments.length <= 1) {
    return [{
      ...base,
      items: Array.isArray(base.items) ? base.items.slice() : [],
      seqNo: 1,
      seqTotal: 1,
      fragmentIndex: 1,
      fragmentTotal: 1,
      fragmentKind: 'single',
    }]
  }

  const total = fragments.length
  return fragments.map((fragment, index) => ({
    ...base,
    items: (Array.isArray(fragment && fragment.items) ? fragment.items : []).map((it) => ({ ...it })),
    seqNo: index + 1,
    seqTotal: total,
    fragmentIndex: index + 1,
    fragmentTotal: total,
    fragmentKind: String((fragment && fragment.kind) || 'middle'),
  }))
}

function byCreatedAtAsc(a, b, toEpochMs) {
  return toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt)
}

function createOrderLabelExportDataService(deps) {
  const {
    db,
    getSale,
    getCustomersByOpenIds,
    getActiveOrdersBySaleWithNicknames,
    filterOrdersByFulfillmentType,
    getSaleFulfillmentPlan,
    buildFulfillmentOrderedOrders,
    toEpochMs,
    normalizePhone,
  } = deps

  async function loadSaleOrThrow(saleId) {
    const id = String(saleId || '').trim()
    if (!id) throw createBizError('BAD_REQUEST', 'Missing saleId')
    let sale = null
    try {
      sale = await getSale(id)
    } catch (err) {
      sale = null
    }
    if (!sale) throw createBizError('NOT_FOUND', 'Sale not found')
    if (String((sale && sale.status) || '').trim() === 'DRAFT') {
      throw createBizError('BAD_REQUEST', 'Draft sale is not exportable')
    }
    return sale
  }

  async function loadOrderOrThrow(orderId) {
    const id = String(orderId || '').trim()
    if (!id) throw createBizError('BAD_REQUEST', 'Missing orderId')
    let order = null
    try {
      const r = await db.collection('orders').doc(id).get()
      order = (r && r.data) || null
    } catch (err) {
      order = null
    }
    if (!order) throw createBizError('NOT_FOUND', 'Order not found')
    let customerNickname = String((order && order.customerNickname) || '').trim()
    const openId = String((order && order.customerOpenId) || '').trim()
    if (!customerNickname && openId) {
      try {
        const customers = await getCustomersByOpenIds([openId])
        const customer = Array.isArray(customers) ? customers[0] : null
        customerNickname = String((customer && customer.nickname) || '').trim()
      } catch (err) {
        customerNickname = ''
      }
    }
    let addressText = String((order && order.addressText) || '').trim()
    if (normalizeFulfillmentType(order && order.fulfillmentType) === 'delivery' && !addressText) {
      const addressId = String((order && order.addressId) || '').trim()
      if (openId && addressId) {
        try {
          const addrRes = await db.collection('customer_addresses').doc(addressId).get()
          const addr = (addrRes && addrRes.data) || null
          if (addr && String((addr && addr.customerOpenId) || '').trim() === openId) {
            addressText = stripTrailingCountryLabel(formatAddressText(addr))
          }
        } catch (err) {
          addressText = ''
        }
      }
    }
    return { ...order, customerNickname, addressText }
  }

  async function loadLabelOrdersBySale(input) {
    const saleId = String((input && input.saleId) || '').trim()
    const includeDelivery = input && input.includeDelivery !== false
    const includePickup = input && input.includePickup !== false
    if (!includeDelivery && !includePickup) {
      throw createBizError('BAD_REQUEST', 'No fulfillment types selected')
    }
    const sale = await loadSaleOrThrow(saleId)
    const allActiveOrders = await getActiveOrdersBySaleWithNicknames(saleId)
    const rawDeliveryOrders = includeDelivery ? filterOrdersByFulfillmentType(allActiveOrders, 'delivery') : []
    const rawPickupOrders = includePickup ? filterOrdersByFulfillmentType(allActiveOrders, 'pickup') : []
    const plan = includeDelivery ? await getSaleFulfillmentPlan(saleId) : null
    const mergedDelivery = includeDelivery
      ? buildFulfillmentOrderedOrders(rawDeliveryOrders, plan && plan.orderIds)
      : { orders: [], appendedOrderIds: [] }
    const pickupOrders = rawPickupOrders.slice().sort((a, b) => byCreatedAtAsc(a, b, toEpochMs))
    return {
      sourceType: 'sale',
      sale,
      orders: [].concat(mergedDelivery.orders || [], pickupOrders),
    }
  }

  async function loadLabelOrderById(input) {
    const orderId = String((input && input.orderId) || '').trim()
    const order = await loadOrderOrThrow(orderId)
    return {
      sourceType: 'order',
      sale: null,
      orders: [order],
    }
  }

  function toLabelDtos(orders) {
    const arr = Array.isArray(orders) ? orders : []
    const out = []
    for (let i = 0; i < arr.length; i += 1) {
      const fragments = expandOrderToLabelFragments(arr[i], { normalizePhone })
      for (let j = 0; j < fragments.length; j += 1) out.push(fragments[j])
    }
    return out
  }

  return {
    loadLabelOrdersBySale,
    loadLabelOrderById,
    toLabelDto(order, seqMeta) {
      return toLabelDto(order, seqMeta, { normalizePhone })
    },
    toLabelDtos,
  }
}

module.exports = {
  createOrderLabelExportDataService,
}
