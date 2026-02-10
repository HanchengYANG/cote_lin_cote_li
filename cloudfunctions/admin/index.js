const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// Admin whitelist enforcement.
const BYPASS_ADMIN_AUTH = false

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

async function requireAdmin(openId) {
  if (BYPASS_ADMIN_AUTH) return await getOrCreateAdminConfig()
  const cfg = await getOrCreateAdminConfig()
  const list = cfg.adminOpenIds || []
  if (!list.includes(openId)) throw Object.assign(new Error('NOT_ADMIN'), { code: 'NOT_ADMIN' })
  return cfg
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function asExcelHtml(title, rows) {
  const head = `<tr>${rows.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
  const body = rows.rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title></head><body><table border="1">${head}${body}</table></body></html>`
}

async function listSales(limit = 20) {
  const r = await db.collection('sales').orderBy('createdAt', 'desc').limit(limit).get()
  return r.data || []
}

async function getSale(saleId) {
  const r = await db.collection('sales').doc(saleId).get()
  return r.data
}

async function getDishesByIds(ids) {
  const dishIds = Array.from(new Set((ids || []).filter(Boolean)))
  if (dishIds.length === 0) return []
  const chunkSize = 10
  const out = []
  for (let i = 0; i < dishIds.length; i += chunkSize) {
    const chunk = dishIds.slice(i, i + chunkSize)
    const r = await db.collection('dishes').where({ _id: _.in(chunk) }).get()
    out.push(...(r.data || []))
  }
  return out
}

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  try {
    await requireAdmin(openId)
  } catch (err) {
    const code = err && err.code
    if (code === 'NOT_ADMIN') return fail('NOT_ADMIN', 'Not admin')
    return fail('NOT_ADMIN', 'Not admin')
  }

  if (action === 'listDishes') {
    const r = await db.collection('dishes').orderBy('updatedAt', 'desc').limit(200).get()
    return ok({ dishes: r.data || [] })
  }

  if (action === 'getDish') {
    const { dishId } = event
    if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
    try {
      const r = await db.collection('dishes').doc(dishId).get()
      return ok({ dish: r.data })
    } catch (err) {
      return fail('NOT_FOUND', 'Dish not found')
    }
  }

  if (action === 'upsertDish') {
    const dishId = event.dishId
    const name = String(event.name || '').trim()
    const priceFen = Number(event.priceFen || 0)
    const isActive = !!event.isActive
    if (!name) return fail('BAD_REQUEST', 'Missing name')
    if (!Number.isFinite(priceFen) || priceFen <= 0) return fail('BAD_REQUEST', 'Invalid price')
    const now = db.serverDate()
    if (dishId) {
      await db.collection('dishes').doc(dishId).update({
        data: { name, priceFen, isActive, updatedAt: now },
      })
      return ok({ dishId })
    }
    const addRes = await db.collection('dishes').add({
      data: { name, priceFen, isActive, createdAt: now, updatedAt: now },
    })
    return ok({ dishId: addRes._id })
  }

  if (action === 'toggleDishActive') {
    const { dishId, isActive } = event
    if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
    await db.collection('dishes').doc(dishId).update({
      data: { isActive: !!isActive, updatedAt: db.serverDate() },
    })
    return ok({})
  }

  if (action === 'listSales') {
    const limit = Math.min(50, Math.max(1, Number(event.limit || 20)))
    const sales = await listSales(limit)
    return ok({ sales })
  }

  if (action === 'getDashboard') {
    const cfg = await getOrCreateAdminConfig()
    const activeSaleId = cfg.activeSaleId
    let activeSale = null
    let orderCount = 0
    if (activeSaleId) {
      try {
        activeSale = await getSale(activeSaleId)
        const o = await db.collection('orders').where({ saleId: activeSaleId }).limit(500).get()
        orderCount = (o.data || []).filter((x) => x.status === 'ACTIVE').length
      } catch (err) {
        activeSale = null
      }
    }
    return ok({ activeSale, stats: { orderCount } })
  }

  if (action === 'getOrCreateDraft') {
    const sales = await listSales(50)
    const draft = (sales || []).find((s) => s.status === 'DRAFT')
    if (draft) return ok({ sale: draft })
    const now = db.serverDate()
    const addRes = await db.collection('sales').add({
      data: {
        status: 'DRAFT',
        dishIds: [],
        note: '',
        deliveryTimeSlotLabel: '',
        createdAt: now,
        updatedAt: now,
      },
    })
    const sale = await getSale(addRes._id)
    return ok({ sale })
  }

  if (action === 'updateSaleDraft') {
    const { saleId } = event
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    const sale = await getSale(saleId)
    if (!sale || sale.status !== 'DRAFT') return fail('BAD_REQUEST', 'Sale is not draft')
    const deliveryTimeSlotLabel = String(event.deliveryTimeSlotLabel || '').trim()
    const note = String(event.note || '').trim()
    const dishIds = Array.isArray(event.dishIds) ? event.dishIds.filter(Boolean) : []
    if (!deliveryTimeSlotLabel) return fail('BAD_REQUEST', 'Missing deliveryTimeSlotLabel')
    if (dishIds.length === 0) return fail('BAD_REQUEST', 'Missing dishIds')
    await db.collection('sales').doc(saleId).update({
      data: {
        deliveryTimeSlotLabel,
        note,
        dishIds,
        updatedAt: db.serverDate(),
      },
    })
    return ok({})
  }

  if (action === 'openSale') {
    const { saleId } = event
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    const sale = await getSale(saleId)
    if (!sale || sale.status !== 'DRAFT') return fail('BAD_REQUEST', 'Sale is not draft')
    if (!String(sale.deliveryTimeSlotLabel || '').trim()) return fail('BAD_REQUEST', 'Missing deliveryTimeSlotLabel')
    if (!sale.dishIds || sale.dishIds.length === 0) return fail('BAD_REQUEST', 'Missing dishIds')

    try {
      await db.runTransaction(async (tx) => {
        const cfgRef = tx.collection('adminConfig').doc('main')
        let cfg
        try {
          const cfgGet = await cfgRef.get()
          cfg = cfgGet.data
        } catch (err) {
          await cfgRef.set({
            data: { adminOpenIds: [], activeSaleId: null, updatedAt: db.serverDate() },
          })
          const cfgGet2 = await cfgRef.get()
          cfg = cfgGet2.data
        }
        if (cfg.activeSaleId) throw Object.assign(new Error('ACTIVE_SALE_EXISTS'), { code: 'ACTIVE_SALE_EXISTS' })
        await cfgRef.update({ data: { activeSaleId: saleId, updatedAt: db.serverDate() } })
        await tx.collection('sales').doc(saleId).update({
          data: { status: 'OPEN', openedAt: db.serverDate(), updatedAt: db.serverDate() },
        })
      })
    } catch (err) {
      if (err && err.code === 'ACTIVE_SALE_EXISTS') return fail('ACTIVE_SALE_EXISTS', '已有开单中开单，请先截单')
      return fail('TX_FAILED', 'Open sale failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'closeSale') {
    const { saleId } = event
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    try {
      await db.runTransaction(async (tx) => {
        const cfgRef = tx.collection('adminConfig').doc('main')
        const cfgGet = await cfgRef.get()
        const cfg = cfgGet.data
        if (!cfg.activeSaleId || cfg.activeSaleId !== saleId) {
          throw Object.assign(new Error('NOT_ACTIVE'), { code: 'NOT_ACTIVE' })
        }
        await cfgRef.update({ data: { activeSaleId: null, updatedAt: db.serverDate() } })
        await tx.collection('sales').doc(saleId).update({
          data: { status: 'CLOSED', closedAt: db.serverDate(), updatedAt: db.serverDate() },
        })
      })
    } catch (err) {
      return fail('TX_FAILED', 'Close sale failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'listOrders') {
    const saleId = event.saleId
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    const fulfillmentType = event.fulfillmentType
    const where = { saleId }
    if (fulfillmentType === 'delivery' || fulfillmentType === 'pickup') where.fulfillmentType = fulfillmentType
    const r = await db.collection('orders').where(where).limit(200).get()
    return ok({ orders: r.data || [] })
  }

  if (action === 'getOrderDetail') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    try {
      const r = await db.collection('orders').doc(orderId).get()
      return ok({ order: r.data })
    } catch (err) {
      return fail('ORDER_NOT_FOUND', 'Order not found')
    }
  }

  if (action === 'cancelOrder') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    let order
    try {
      const r = await db.collection('orders').doc(orderId).get()
      order = r.data
    } catch (err) {
      return fail('ORDER_NOT_FOUND', 'Order not found')
    }
    if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
    if (order.status === 'CANCELLED') return ok({})
    const now = db.serverDate()
    await db.collection('orders').doc(orderId).update({
      data: { status: 'CANCELLED', cancelledAt: now, cancelledByOpenId: openId, updatedAt: now },
    })
    await db.collection('orderAuditLogs').add({
      data: { orderId, action: 'CANCEL', byOpenId: openId, at: now },
    })
    return ok({})
  }

  if (action === 'export') {
    const { saleId, exportType } = event
    const includeCancelled = !!event.includeCancelled
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    if (!exportType) return fail('BAD_REQUEST', 'Missing exportType')

    let sale
    try {
      sale = await getSale(saleId)
    } catch (err) {
      return fail('NOT_FOUND', 'Sale not found')
    }
    if (!sale) return fail('NOT_FOUND', 'Sale not found')

    const where = { saleId }
    if (!includeCancelled) where.status = 'ACTIVE'
    const orderRes = await db.collection('orders').where(where).limit(500).get()
    const orders = orderRes.data || []
    orders.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return ta - tb
    })

    const title = `${exportType}-${saleId}`
    let table

    if (exportType === 'ORDER_DETAIL') {
      const headers = [
        '订单号',
        '下单时间',
        '类型',
        '时间段',
        '电话',
        '省',
        '市',
        '区',
        '详细地址',
        '补充',
        '备注',
        '付款方式',
        '收款状态',
        '订单状态',
        '菜品明细',
        '总件数',
        '总金额(分)',
      ]
      const rows = orders.map((o) => {
        const a = o.address || {}
        const itemText = (o.items || []).map((it) => `${it.dishName} x${it.qty}`).join('; ')
        return [
          o._id,
          o.createdAt ? String(o.createdAt) : '',
          o.fulfillmentType,
          o.deliveryTimeSlotLabelSnapshot || '',
          (o.contact && o.contact.phone) || '',
          a.province || '',
          a.city || '',
          a.district || '',
          a.detail || '',
          a.extra || '',
          o.remark || '',
          (o.payment && o.payment.method) || '',
          (o.payment && o.payment.paidStatus) || '',
          o.status || '',
          itemText,
          (o.totals && o.totals.qty) || 0,
          (o.totals && o.totals.amountFen) || 0,
        ]
      })
      table = { headers, rows }
    } else if (exportType === 'DISH_SUMMARY') {
      const map = new Map()
      for (const o of orders) {
        for (const it of o.items || []) {
          const key = it.dishName || it.dishId
          const prev = map.get(key) || 0
          map.set(key, prev + Number(it.qty || 0))
        }
      }
      const headers = ['菜品', '总份数']
      const rows = Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, qty]) => [name, qty])
      table = { headers, rows }
    } else if (exportType === 'CUSTOMER_ADDRESS') {
      const headers = ['订单号', '类型', '时间段', '电话', '地址', '备注', '菜品明细']
      const rows = orders.map((o) => {
        const a = o.address || {}
        const addr = [a.province, a.city, a.district, a.detail, a.extra].filter(Boolean).join('')
        const itemText = (o.items || []).map((it) => `${it.dishName} x${it.qty}`).join('; ')
        return [
          o._id,
          o.fulfillmentType,
          o.deliveryTimeSlotLabelSnapshot || '',
          (o.contact && o.contact.phone) || '',
          addr,
          o.remark || '',
          itemText,
        ]
      })
      table = { headers, rows }
    } else {
      return fail('BAD_REQUEST', 'Unknown exportType')
    }

    const html = asExcelHtml(title, table)
    const ts = Date.now()
    const filename = `${exportType}-${ts}.xls`
    const cloudPath = `exports/${saleId}/${filename}`
    const up = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from(html, 'utf8'),
    })
    return ok({ fileID: up.fileID, cloudPath, filename })
  }

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
