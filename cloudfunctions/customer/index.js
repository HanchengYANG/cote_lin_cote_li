const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, detail) {
  return { ok: false, code, message, detail }
}

async function getOrCreateAdminConfig() {
  const ref = db.collection('adminConfig').doc('main')
  try {
    const r = await ref.get()
    return r.data
  } catch (err) {
    await ref.set({
      data: {
        adminOpenIds: [],
        activeSaleId: null,
        updatedAt: db.serverDate(),
      },
    })
    const r2 = await ref.get()
    return r2.data
  }
}

async function getActiveSale() {
  const cfg = await getOrCreateAdminConfig()
  const activeSaleId = cfg.activeSaleId
  if (!activeSaleId) return null
  try {
    const r = await db.collection('sales').doc(activeSaleId).get()
    const sale = r.data
    if (!sale || sale.status !== 'OPEN') return null
    return sale
  } catch (err) {
    return null
  }
}

async function getDishesByIds(ids) {
  const dishIds = Array.from(new Set((ids || []).filter(Boolean)))
  if (dishIds.length === 0) return []
  // `in` query has size limits; keep chunks small for compatibility.
  const chunkSize = 10
  const out = []
  for (let i = 0; i < dishIds.length; i += chunkSize) {
    const chunk = dishIds.slice(i, i + chunkSize)
    const r = await db
      .collection('dishes')
      .where({
        _id: _.in(chunk),
      })
      .get()
    out.push(...(r.data || []).filter((d) => d && d.isActive))
  }
  return out
}

function isPhoneValid(phone) {
  const s = String(phone || '').trim()
  return /^(\+?\d{6,20})$/.test(s)
}

function isAddressValid(addr) {
  if (!addr) return false
  const need = ['province', 'city', 'district', 'detail']
  for (const k of need) {
    if (!String(addr[k] || '').trim()) return false
  }
  return true
}

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  if (action === 'getCurrentSale') {
    const sale = await getActiveSale()
    if (!sale) return ok({ sale: null, dishes: [] })
    const dishes = await getDishesByIds(sale.dishIds || [])
    return ok({ sale, dishes })
  }

  if (action === 'listMyOrders') {
    const r = await db
      .collection('orders')
      .where({ customerOpenId: openId })
      .limit(50)
      .get()
    return ok({ orders: r.data || [] })
  }

  if (action === 'getMyOrderDetail') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    let r
    try {
      r = await db.collection('orders').doc(orderId).get()
    } catch (err) {
      return fail('ORDER_NOT_FOUND', 'Order not found')
    }
    const order = r.data
    if (!order || order.customerOpenId !== openId) return fail('FORBIDDEN', 'Forbidden')
    return ok({ order })
  }

  if (action === 'createOrder') {
    const sale = await getActiveSale()
    if (!sale) return fail('NOT_OPEN', 'Not open for ordering')
    const saleId = event.saleId
    if (!saleId || saleId !== sale._id) return fail('NOT_OPEN', 'Not open for ordering')

    const fulfillmentType = event.fulfillmentType
    if (fulfillmentType !== 'delivery' && fulfillmentType !== 'pickup') {
      return fail('BAD_REQUEST', 'Invalid fulfillmentType')
    }

    const phone = String(event.phone || '').trim()
    if (!isPhoneValid(phone)) return fail('INVALID_PHONE', 'Invalid phone')

    const address = event.address
    const acceptDeliverySlot = !!event.acceptDeliverySlot
    if (fulfillmentType === 'delivery') {
      if (!isAddressValid(address)) return fail('INVALID_ADDRESS', 'Invalid address')
      if (!acceptDeliverySlot) return fail('DELIVERY_SLOT_NOT_ACCEPTED', 'Delivery slot not accepted')
      if (!String(sale.deliveryTimeSlotLabel || '').trim()) return fail('NOT_OPEN', 'Delivery slot not set')
    }

    const items = Array.isArray(event.items) ? event.items : []
    if (items.length === 0) return fail('BAD_REQUEST', 'Empty items')

    const qtyById = new Map()
    for (const it of items) {
      const dishId = it && it.dishId
      const qty = Number(it && it.qty)
      if (!dishId || !Number.isFinite(qty) || qty <= 0) continue
      qtyById.set(dishId, (qtyById.get(dishId) || 0) + Math.floor(qty))
    }
    if (qtyById.size === 0) return fail('BAD_REQUEST', 'Empty items')

    const allowed = new Set((sale.dishIds || []).filter(Boolean))
    for (const dishId of qtyById.keys()) {
      if (!allowed.has(dishId)) return fail('ITEM_NOT_ALLOWED', 'Item not allowed')
    }

    const dishIds = Array.from(qtyById.keys())
    const dishList = await getDishesByIds(dishIds)
    const dishMap = new Map(dishList.map((d) => [d._id, d]))
    if (dishMap.size !== dishIds.length) return fail('ITEM_NOT_ALLOWED', 'Item not allowed')

    const orderItems = []
    let totalQty = 0
    let totalAmountFen = 0
    for (const dishId of dishIds) {
      const d = dishMap.get(dishId)
      const qty = qtyById.get(dishId) || 0
      const unitPriceFen = Number(d.priceFen || 0)
      const lineTotalFen = unitPriceFen * qty
      totalQty += qty
      totalAmountFen += lineTotalFen
      orderItems.push({
        dishId,
        dishName: d.name,
        unitPriceFen,
        qty,
        lineTotalFen,
      })
    }

    const payment = event.payment || {}
    const paymentMethod = String(payment.method || 'cash')
    const paidStatus = String(payment.paidStatus || 'UNPAID')

    const now = db.serverDate()
    const doc = {
      saleId: sale._id,
      customerOpenId: openId,
      status: 'ACTIVE',
      fulfillmentType,
      deliveryTimeSlotLabelSnapshot: fulfillmentType === 'delivery' ? String(sale.deliveryTimeSlotLabel || '').trim() : null,
      acceptDeliverySlot: fulfillmentType === 'delivery' ? true : false,
      contact: { phone },
      address: fulfillmentType === 'delivery' ? address : null,
      payment: { method: paymentMethod, paidStatus },
      remark: String(event.remark || '').trim(),
      items: orderItems,
      totals: { qty: totalQty, amountFen: totalAmountFen },
      createdAt: now,
      updatedAt: now,
    }

    const addRes = await db.collection('orders').add({ data: doc })
    const orderId = addRes && addRes._id
    await db.collection('orderAuditLogs').add({
      data: {
        orderId,
        action: 'CREATE',
        byOpenId: openId,
        at: now,
      },
    })
    return ok({ orderId })
  }

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
