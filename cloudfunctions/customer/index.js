const cloud = require('wx-server-sdk')
const https = require('https')
const {
  buildAddressId,
  toSafeInt,
  pickLatestOrder,
  normalizeCityKey,
  normalizePhone,
  isPhoneValid,
  isAddressValid,
  normalizeAddressPayload,
  normalizeStoredAddresses,
  sanitizeProfileNickname,
  toProfileOutput,
  toProfileSummary,
  buildDeliveryMinRule,
  attachMinOrderInfo,
} = require('./lib/shared')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const ORDER_STATUS = {
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  REJECTED: 'REJECTED',
}

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

function normalizeSaleDishConfigs(sale) {
  const raw = Array.isArray(sale && sale.dishConfigs) ? sale.dishConfigs : []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const dishId = String((item && item.dishId) || '').trim()
    if (!dishId || seen.has(dishId)) continue
    const limitQty = Math.max(0, toSafeInt(item && item.limitQty, 0))
    const soldQty = Math.max(0, Math.min(limitQty, toSafeInt(item && item.soldQty, 0)))
    out.push({ dishId, limitQty, soldQty })
    seen.add(dishId)
  }
  return out
}

function validateSaleDishConfigs(sale, normalizedConfigs) {
  const saleDishIds = Array.isArray(sale && sale.dishIds) ? sale.dishIds.filter(Boolean).map((x) => String(x)) : []
  const saleSet = new Set(saleDishIds)
  const cfg = Array.isArray(normalizedConfigs) ? normalizedConfigs : normalizeSaleDishConfigs(sale)
  const cfgSet = new Set(cfg.map((x) => x.dishId))
  if (saleSet.size === 0) return { ok: false, message: 'Sale has no dishIds' }
  if (cfgSet.size === 0) return { ok: false, message: 'Sale has no dishConfigs' }
  if (cfgSet.size !== saleSet.size) return { ok: false, message: 'sale.dishIds and sale.dishConfigs mismatch' }
  for (const dishId of saleSet) {
    if (!cfgSet.has(dishId)) return { ok: false, message: `dish config missing: ${dishId}` }
  }
  return { ok: true }
}

function throwBiz(code, message, detail) {
  const err = new Error(message || code || 'BIZ_ERROR')
  err.code = code || 'BIZ_ERROR'
  err.detail = detail
  throw err
}

async function getDishesByIds(ids, options = {}) {
  const onlyActive = options.onlyActive !== false
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
    out.push(...(r.data || []).filter((d) => d && (!onlyActive || d.isActive)))
  }
  return out
}

function normalizeImageIds(input) {
  return Array.isArray(input) ? input.filter(Boolean).map((x) => String(x).trim()).slice(0, 10) : []
}

async function getCustomerDoc(openId) {
  try {
    const r = await db.collection('customers').doc(openId).get()
    return r.data
  } catch (err) {
    return null
  }
}

async function ensureCustomerDoc(openId) {
  const existing = await getCustomerDoc(openId)
  if (existing) return existing
  const now = db.serverDate()
  await db.collection('customers').doc(openId).set({
    data: {
      nickname: '',
      defaultAddressId: '',
      addresses: [],
      createdAt: now,
      updatedAt: now,
    },
  })
  return getCustomerDoc(openId)
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function getTempUrlMap(fileIDs) {
  const ids = Array.from(new Set((fileIDs || []).filter(Boolean)))
  if (ids.length === 0) return new Map()
  const r = await cloud.getTempFileURL({ fileList: ids })
  const out = new Map()
  for (const it of (r.fileList || [])) {
    if (it && it.fileID && it.tempFileURL) out.set(it.fileID, it.tempFileURL)
  }
  return out
}

function mdToSafeHtml(md) {
  // Lazy-load dependency; requires `markdown-it` in package.json.
  // eslint-disable-next-line global-require
  const MarkdownIt = require('markdown-it')
  const it = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: true,
    typographer: false,
  })

  // Disallow images.
  it.renderer.rules.image = () => ''

  // Map headings to strong paragraphs (rich-text tag support is limited).
  it.renderer.rules.heading_open = () => '<p><strong>'
  it.renderer.rules.heading_close = () => '</strong></p>'

  // Preprocess: remove images + downgrade links to plain text.
  let s = String(md || '')
  s = s.replace(/!\[[^\]]*?\]\([^)]+\)/g, '')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => `${text} (${url})`)
  s = s.replace(/<((https?:\/\/)[^>]+)>/g, (_m, url) => url)

  return it.render(s)
}

exports.main = async (event) => {
  const { action } = event || {}
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID

  if (action === 'getMyProfile') {
    const doc = await ensureCustomerDoc(openId)
    const cfg = await getOrCreateAdminConfig()
    return ok({ profile: attachMinOrderInfo(toProfileOutput(doc), buildDeliveryMinRule(cfg)) })
  }

  if (action === 'completeMyProfile') {
    const nickname = sanitizeProfileNickname(event.nickname)
    const address = normalizeAddressPayload(event.address, { requireLabel: true })
    if (!nickname) return fail('BAD_REQUEST', '缺少昵称')
    if (!address) return fail('INVALID_ADDRESS', '地址格式不正确')
    let profile = null
    try {
      profile = await db.runTransaction(async (tx) => {
        let customer = null
        try {
          const got = await tx.collection('customers').doc(openId).get()
          customer = got.data
        } catch (err) {
          customer = null
        }
        const oldAddresses = normalizeStoredAddresses(customer && customer.addresses)
        const nowMs = Date.now()
        let addresses = oldAddresses
        let matched = oldAddresses.find((x) => {
          return x.line1 === address.line1 && x.line2 === address.line2 && x.postalCode === address.postalCode && x.city === address.city
        })
        if (!matched) {
          matched = {
            id: buildAddressId(),
            ...address,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          }
          addresses = oldAddresses.concat([matched])
        } else {
          addresses = oldAddresses.map((x) => {
            if (x.id !== matched.id) return x
            return {
              ...x,
              ...address,
              updatedAtMs: nowMs,
            }
          })
          matched = addresses.find((x) => x.id === matched.id) || matched
        }
        const defaultAddressId = matched.id
        const saveData = {
          nickname,
          addresses,
          defaultAddressId,
          updatedAt: db.serverDate(),
        }
        if (customer) {
          await tx.collection('customers').doc(openId).update({ data: saveData })
        } else {
          await tx.collection('customers').doc(openId).set({
            data: {
              ...saveData,
              createdAt: db.serverDate(),
            },
          })
        }
        return toProfileOutput({ nickname, addresses, defaultAddressId })
      })
    } catch (err) {
      return fail('TX_FAILED', '保存资料失败', String(err && err.message))
    }
    const cfg = await getOrCreateAdminConfig()
    return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
  }

  if (action === 'addMyAddress') {
    const address = normalizeAddressPayload(event.address, { requireLabel: true })
    if (!address) return fail('INVALID_ADDRESS', '地址格式不正确')
    const setDefault = !!event.setDefault
    let profile = null
    try {
      profile = await db.runTransaction(async (tx) => {
        let customer = null
        try {
          const got = await tx.collection('customers').doc(openId).get()
          customer = got.data
        } catch (err) {
          customer = null
        }
        const nickname = sanitizeProfileNickname(customer && customer.nickname)
        const oldAddresses = normalizeStoredAddresses(customer && customer.addresses)
        const nowMs = Date.now()
        const newAddr = {
          id: buildAddressId(),
          ...address,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        }
        const addresses = oldAddresses.concat([newAddr])
        let defaultAddressId = String((customer && customer.defaultAddressId) || '').trim()
        if (!addresses.some((x) => x.id === defaultAddressId)) defaultAddressId = ''
        if (setDefault || !defaultAddressId) defaultAddressId = newAddr.id
        const saveData = {
          nickname,
          addresses,
          defaultAddressId,
          updatedAt: db.serverDate(),
        }
        if (customer) {
          await tx.collection('customers').doc(openId).update({ data: saveData })
        } else {
          await tx.collection('customers').doc(openId).set({
            data: {
              ...saveData,
              createdAt: db.serverDate(),
            },
          })
        }
        return toProfileOutput({ nickname, addresses, defaultAddressId })
      })
    } catch (err) {
      return fail('TX_FAILED', '保存地址失败', String(err && err.message))
    }
    const cfg = await getOrCreateAdminConfig()
    return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
  }

  if (action === 'updateMyAddress') {
    const addressId = String(event.addressId || '').trim()
    const address = normalizeAddressPayload(event.address, { requireLabel: true })
    if (!addressId) return fail('BAD_REQUEST', '缺少 addressId')
    if (!address) return fail('INVALID_ADDRESS', '地址格式不正确')
    const setDefault = !!event.setDefault
    let profile = null
    try {
      profile = await db.runTransaction(async (tx) => {
        let customer = null
        try {
          const got = await tx.collection('customers').doc(openId).get()
          customer = got.data
        } catch (err) {
          customer = null
        }
        if (!customer) throwBiz('BAD_REQUEST', '请先完善资料')
        const nickname = sanitizeProfileNickname(customer.nickname)
        const oldAddresses = normalizeStoredAddresses(customer.addresses)
        let found = false
        const nowMs = Date.now()
        const addresses = oldAddresses.map((x) => {
          if (x.id !== addressId) return x
          found = true
          return {
            ...x,
            ...address,
            updatedAtMs: nowMs,
          }
        })
        if (!found) throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
        let defaultAddressId = String(customer.defaultAddressId || '').trim()
        if (!addresses.some((x) => x.id === defaultAddressId)) defaultAddressId = addresses[0] ? addresses[0].id : ''
        if (setDefault) defaultAddressId = addressId
        await tx.collection('customers').doc(openId).update({
          data: {
            nickname,
            addresses,
            defaultAddressId,
            updatedAt: db.serverDate(),
          },
        })
        return toProfileOutput({ nickname, addresses, defaultAddressId })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || '保存地址失败', err.detail)
      return fail('TX_FAILED', '保存地址失败', String(err && err.message))
    }
    const cfg = await getOrCreateAdminConfig()
    return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
  }

  if (action === 'deleteMyAddress') {
    const addressId = String(event.addressId || '').trim()
    if (!addressId) return fail('BAD_REQUEST', '缺少 addressId')
    let profile = null
    try {
      profile = await db.runTransaction(async (tx) => {
        let customer = null
        try {
          const got = await tx.collection('customers').doc(openId).get()
          customer = got.data
        } catch (err) {
          customer = null
        }
        if (!customer) throwBiz('BAD_REQUEST', '请先完善资料')
        const nickname = sanitizeProfileNickname(customer.nickname)
        const oldAddresses = normalizeStoredAddresses(customer.addresses)
        const addresses = oldAddresses.filter((x) => x.id !== addressId)
        if (addresses.length === oldAddresses.length) throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
        let defaultAddressId = String(customer.defaultAddressId || '').trim()
        if (defaultAddressId === addressId || !addresses.some((x) => x.id === defaultAddressId)) {
          defaultAddressId = addresses[0] ? addresses[0].id : ''
        }
        await tx.collection('customers').doc(openId).update({
          data: {
            nickname,
            addresses,
            defaultAddressId,
            updatedAt: db.serverDate(),
          },
        })
        return toProfileOutput({ nickname, addresses, defaultAddressId })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || '删除地址失败', err.detail)
      return fail('TX_FAILED', '删除地址失败', String(err && err.message))
    }
    const cfg = await getOrCreateAdminConfig()
    return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
  }

  if (action === 'setDefaultAddress') {
    const addressId = String(event.addressId || '').trim()
    if (!addressId) return fail('BAD_REQUEST', '缺少 addressId')
    let profile = null
    try {
      profile = await db.runTransaction(async (tx) => {
        let customer = null
        try {
          const got = await tx.collection('customers').doc(openId).get()
          customer = got.data
        } catch (err) {
          customer = null
        }
        if (!customer) throwBiz('BAD_REQUEST', '请先完善资料')
        const nickname = sanitizeProfileNickname(customer.nickname)
        const addresses = normalizeStoredAddresses(customer.addresses)
        if (!addresses.some((x) => x.id === addressId)) throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
        await tx.collection('customers').doc(openId).update({
          data: {
            nickname,
            addresses,
            defaultAddressId: addressId,
            updatedAt: db.serverDate(),
          },
        })
        return toProfileOutput({ nickname, addresses, defaultAddressId: addressId })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || '设置默认地址失败', err.detail)
      return fail('TX_FAILED', '设置默认地址失败', String(err && err.message))
    }
    const cfg = await getOrCreateAdminConfig()
    return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
  }

  if (action === 'listActiveDishesForBrowse') {
    const r = await db
      .collection('dishes')
      .where({ isActive: true })
      .orderBy('updatedAt', 'desc')
      .limit(200)
      .get()
    const dishes = (r.data || []).map((d) => ({
      ...d,
      images: normalizeImageIds(d.images),
      descPlain: String(d.descPlain || ''),
    }))
    const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
    const urlMap = await getTempUrlMap(firstIds)
    const out = dishes.map((d) => ({
      _id: d._id,
      name: d.name,
      priceCents: d.priceCents || 0,
      descPlain: d.descPlain,
      images: d.images,
      thumbUrl: urlMap.get(d.images[0] || '') || '',
    }))
    return ok({ dishes: out })
  }

  if (action === 'bootstrapHome') {
    const sale = await getActiveSale()
    const profileDoc = await ensureCustomerDoc(openId)
    const r = await db
      .collection('dishes')
      .where({ isActive: true })
      .orderBy('updatedAt', 'desc')
      .limit(200)
      .get()
    const dishes = (r.data || []).map((d) => ({
      ...d,
      images: normalizeImageIds(d.images),
      descPlain: String(d.descPlain || ''),
    }))
    const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
    const urlMap = await getTempUrlMap(firstIds)

    let saleInfo = {
      isOpen: false,
      saleId: '',
      deliveryTimeSlotLabel: '',
    }
    let cfgMap = new Map()
    if (sale) {
      const normalizedConfigs = normalizeSaleDishConfigs(sale)
      const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
      if (!configCheck.ok) return fail('SALE_CONFIG_INVALID', configCheck.message)
      cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
      saleInfo = {
        isOpen: true,
        saleId: String(sale._id || ''),
        deliveryTimeSlotLabel: String(sale.deliveryTimeSlotLabel || ''),
      }
    }

    const out = dishes.map((d) => {
      const cfg = cfgMap.get(d._id) || null
      const limitQty = cfg ? cfg.limitQty : 0
      const soldQty = cfg ? cfg.soldQty : 0
      const remainingQty = cfg ? Math.max(0, limitQty - soldQty) : 0
      return {
        _id: d._id,
        name: d.name,
        priceCents: d.priceCents || 0,
        descPlain: d.descPlain,
        images: d.images,
        thumbUrl: urlMap.get(d.images[0] || '') || '',
        inSale: !!cfg,
        limitQty,
        soldQty,
        remainingQty,
        isSoldOut: !!cfg && soldQty >= limitQty,
      }
    })
    return ok({ sale: saleInfo, dishes: out, profile: toProfileSummary(profileDoc) })
  }

  if (action === 'getCurrentSale') {
    const sale = await getActiveSale()
    if (!sale) return ok({ sale: null, dishes: [] })
    const normalizedConfigs = normalizeSaleDishConfigs(sale)
    const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
    if (!configCheck.ok) return fail('SALE_CONFIG_INVALID', configCheck.message)
    const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
    const dishes = (await getDishesByIds(sale.dishIds || [])).map((d) => ({
      ...d,
      images: normalizeImageIds(d.images),
    }))
    const firstIds = dishes.map((d) => d.images[0] || '').filter(Boolean)
    const urlMap = await getTempUrlMap(firstIds)
    const out = dishes.map((d) => ({
      ...d,
      thumbUrl: urlMap.get(d.images[0] || '') || '',
      limitQty: cfgMap.has(d._id) ? cfgMap.get(d._id).limitQty : 0,
      soldQty: cfgMap.has(d._id) ? cfgMap.get(d._id).soldQty : 0,
      remainingQty: cfgMap.has(d._id) ? Math.max(0, cfgMap.get(d._id).limitQty - cfgMap.get(d._id).soldQty) : 0,
      isSoldOut: cfgMap.has(d._id) ? cfgMap.get(d._id).soldQty >= cfgMap.get(d._id).limitQty : true,
    }))
    return ok({ sale: { ...sale, dishConfigs: normalizedConfigs }, dishes: out })
  }

  if (action === 'getDishDetail') {
    const { dishId } = event
    if (!dishId) return fail('BAD_REQUEST', 'Missing dishId')
    let r
    try {
      r = await db.collection('dishes').doc(dishId).get()
    } catch (err) {
      return fail('NOT_FOUND', 'Dish not found')
    }
    const dish = r.data
    if (!dish || !dish.isActive) return ok({ dish: null })
    const imageIds = normalizeImageIds(dish.images)
    const descMd = String(dish.descMd || '')
    let descHtml = ''
    if (descMd.trim()) {
      try {
        descHtml = mdToSafeHtml(descMd)
      } catch (err) {
        descHtml = ''
      }
    }
    const urlMap = await getTempUrlMap(imageIds)
    const imageUrls = imageIds.map((id) => urlMap.get(id) || '')
    return ok({
      dish: {
        _id: dish._id,
        name: dish.name,
        priceCents: dish.priceCents || 0,
        images: imageIds,
        imageUrls,
        descMd,
        descHtml,
      },
    })
  }

  if (action === 'suggestAddress') {
    const q = String(event.q || '').trim()
    const limit = Math.min(10, Math.max(1, Number(event.limit || 5)))
    if (q.length < 3) return ok({ suggestions: [] })
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=${limit}`
    try {
      const json = await httpGetJson(url)
      const features = (json && json.features) || []
      const suggestions = features
        .map((f) => (f && f.properties) || null)
        .filter(Boolean)
        .map((p) => {
          const hn = p.housenumber ? String(p.housenumber) : ''
          const name = p.name ? String(p.name) : (p.street ? String(p.street) : '')
          const line1 = `${hn} ${name}`.trim() || (p.label ? String(p.label) : '')
          return {
            label: String(p.label || line1),
            line1,
            postalCode: String(p.postcode || ''),
            city: String(p.city || ''),
          }
        })
      return ok({ suggestions })
    } catch (err) {
      return fail('SUGGEST_FAILED', 'Suggest failed')
    }
  }

  if (action === 'listMyOrders') {
    const r = await db
      .collection('orders')
      .where({ customerOpenId: openId })
      .limit(50)
      .get()
    return ok({ orders: r.data || [] })
  }

  if (action === 'getMySaleOrder') {
    const saleId = String(event.saleId || '').trim()
    if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
    let order = null
    try {
      const r = await db
        .collection('orders')
        .where({
          saleId,
          customerOpenId: openId,
          status: _.in([ORDER_STATUS.ACTIVE, ORDER_STATUS.PENDING_REVIEW]),
        })
        .limit(20)
        .get()
      order = pickLatestOrder(r.data || [])
    } catch (err) {
      order = null
    }
    return ok({ order })
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

  if (action === 'updateMyOrderItems') {
    const { orderId } = event
    const incomingItems = Array.isArray(event.items) ? event.items : []
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    try {
      await db.runTransaction(async (tx) => {
        let order
        try {
          const orderGet = await tx.collection('orders').doc(orderId).get()
          order = orderGet.data
        } catch (err) {
          throwBiz('ORDER_NOT_FOUND', 'Order not found')
        }
        if (!order || order.customerOpenId !== openId) throwBiz('FORBIDDEN', 'Forbidden')
        if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
          throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')
        }
        if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')

        let sale
        try {
          const saleGet = await tx.collection('sales').doc(order.saleId).get()
          sale = saleGet.data
        } catch (err) {
          sale = null
        }
        if (!sale || sale.status !== 'OPEN') throwBiz('ORDER_LOCKED', 'Sale closed, customer edit disabled')

        const normalizedConfigs = normalizeSaleDishConfigs(sale)
        const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
        if (!configCheck.ok) throwBiz('SALE_CONFIG_INVALID', configCheck.message)
        const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
        const oldItems = Array.isArray(order.items) ? order.items : []
        const oldMap = new Map()
        for (const it of oldItems) {
          const dishId = String((it && it.dishId) || '').trim()
          if (!dishId) continue
          oldMap.set(dishId, it)
        }
        if (oldMap.size === 0) throwBiz('BAD_REQUEST', 'Order has no editable items')

        const nextQtyMap = new Map()
        for (const it of incomingItems) {
          const dishId = String((it && it.dishId) || '').trim()
          const qty = Number(it && it.qty)
          if (!dishId || !Number.isFinite(qty) || qty < 0) throwBiz('BAD_REQUEST', 'Invalid items')
          if (!oldMap.has(dishId)) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
          nextQtyMap.set(dishId, Math.floor(qty))
        }
        for (const dishId of oldMap.keys()) {
          if (!nextQtyMap.has(dishId)) nextQtyMap.set(dishId, 0)
        }

        if (order.status === ORDER_STATUS.ACTIVE) {
          const outOfStock = []
          for (const [dishId, nextQty] of nextQtyMap.entries()) {
            const oldQty = toSafeInt(oldMap.get(dishId) && oldMap.get(dishId).qty, 0)
            const delta = nextQty - oldQty
            if (delta <= 0) continue
            const cfgItem = cfgMap.get(dishId)
            if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
            const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
            if (delta > remain) {
              outOfStock.push({
                dishId,
                dishName: String((oldMap.get(dishId) && oldMap.get(dishId).dishName) || ''),
                remainingQty: remain,
                requiredQty: delta,
              })
            }
          }
          if (outOfStock.length > 0) throwBiz('OUT_OF_STOCK', 'Out of stock', { items: outOfStock })

          for (const [dishId, nextQty] of nextQtyMap.entries()) {
            const oldQty = toSafeInt(oldMap.get(dishId) && oldMap.get(dishId).qty, 0)
            const delta = nextQty - oldQty
            if (delta === 0) continue
            const cfgItem = cfgMap.get(dishId)
            if (!cfgItem) continue
            cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + delta)
            cfgMap.set(dishId, cfgItem)
          }
        }

        const nextItems = []
        let totalQty = 0
        let totalAmountCents = 0
        for (const [dishId, nextQty] of nextQtyMap.entries()) {
          if (nextQty <= 0) continue
          const old = oldMap.get(dishId)
          const unitPriceCents = toSafeInt(old && old.unitPriceCents, 0)
          const dishName = String((old && old.dishName) || '')
          if (!dishName) throwBiz('BAD_REQUEST', 'Invalid order item')
          const lineTotalCents = unitPriceCents * nextQty
          totalQty += nextQty
          totalAmountCents += lineTotalCents
          nextItems.push({ dishId, dishName, unitPriceCents, qty: nextQty, lineTotalCents })
        }
        if (nextItems.length === 0) throwBiz('BAD_REQUEST', 'Order cannot be empty, cancel it instead')

        if (order.status === ORDER_STATUS.ACTIVE) {
          const updatedConfigs = normalizedConfigs.map((x) => {
            const cur = cfgMap.get(x.dishId)
            return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
          })
          await tx.collection('sales').doc(order.saleId).update({
            data: {
              dishConfigs: updatedConfigs,
              updatedAt: db.serverDate(),
            },
          })
        }

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: {
            items: nextItems,
            totals: { qty: totalQty, amountCents: totalAmountCents },
            saleConfigVersionSnapshot:
              order.status === ORDER_STATUS.ACTIVE ? toSafeInt(sale.saleConfigVersion, 0) : toSafeInt(order.saleConfigVersionSnapshot, 0),
            updatedAt: now,
          },
        })
        await tx.collection('orderAuditLogs').add({
          data: {
            orderId,
            action: order.status === ORDER_STATUS.ACTIVE ? 'CUSTOMER_UPDATE_ITEMS' : 'CUSTOMER_UPDATE_PENDING_ITEMS',
            byOpenId: openId,
            at: now,
          },
        })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
      return fail('TX_FAILED', 'Update order failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'cancelMyOrder') {
    const { orderId } = event
    if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
    try {
      await db.runTransaction(async (tx) => {
        let order
        try {
          const orderGet = await tx.collection('orders').doc(orderId).get()
          order = orderGet.data
        } catch (err) {
          throwBiz('ORDER_NOT_FOUND', 'Order not found')
        }
        if (!order || order.customerOpenId !== openId) throwBiz('FORBIDDEN', 'Forbidden')
        if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.REJECTED) return
        if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
          throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')
        }
        if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')

        let sale
        try {
          const saleGet = await tx.collection('sales').doc(order.saleId).get()
          sale = saleGet.data
        } catch (err) {
          sale = null
        }
        if (!sale || sale.status !== 'OPEN') throwBiz('ORDER_LOCKED', 'Sale closed, customer cancel disabled')

        if (order.status === ORDER_STATUS.ACTIVE) {
          const normalizedConfigs = normalizeSaleDishConfigs(sale)
          const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
          if (!configCheck.ok) throwBiz('SALE_CONFIG_INVALID', configCheck.message)
          const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
          for (const it of (order.items || [])) {
            const dishId = String((it && it.dishId) || '').trim()
            const qty = toSafeInt(it && it.qty, 0)
            if (!dishId || qty <= 0) continue
            const cfgItem = cfgMap.get(dishId)
            if (!cfgItem) continue
            cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) - qty)
            cfgMap.set(dishId, cfgItem)
          }
          const updatedConfigs = normalizedConfigs.map((x) => {
            const cur = cfgMap.get(x.dishId)
            return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
          })
          await tx.collection('sales').doc(order.saleId).update({
            data: { dishConfigs: updatedConfigs, updatedAt: db.serverDate() },
          })
        }

        const now = db.serverDate()
        await tx.collection('orders').doc(orderId).update({
          data: {
            status: ORDER_STATUS.CANCELLED,
            cancelledAt: now,
            cancelledByOpenId: openId,
            updatedAt: now,
          },
        })
        await tx.collection('orderAuditLogs').add({
          data: {
            orderId,
            action: 'CUSTOMER_CANCEL',
            byOpenId: openId,
            at: now,
          },
        })
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
      return fail('TX_FAILED', 'Cancel order failed', String(err && err.message))
    }
    return ok({})
  }

  if (action === 'createOrder') {
    const sale = await getActiveSale()
    if (!sale) return fail('NOT_OPEN', 'Not open for ordering')
    const saleId = event.saleId
    if (!saleId || saleId !== sale._id) return fail('NOT_OPEN', 'Not open for ordering')

    const requestedFulfillmentType = event.fulfillmentType
    if (requestedFulfillmentType !== 'delivery' && requestedFulfillmentType !== 'pickup') {
      return fail('BAD_REQUEST', 'Invalid fulfillmentType')
    }

    const requestedAddressId = String(event.addressId || '').trim()
    const requestedAcceptDeliverySlot = !!event.acceptDeliverySlot
    const requestedPhone = normalizePhone(event.phone)

    const items = Array.isArray(event.items) ? event.items : []
    if (items.length === 0) return fail('BAD_REQUEST', 'Empty items')

    const incomingQtyById = new Map()
    for (const it of items) {
      const dishId = it && it.dishId
      const qty = Number(it && it.qty)
      if (!dishId || !Number.isFinite(qty) || qty <= 0) continue
      incomingQtyById.set(dishId, (incomingQtyById.get(dishId) || 0) + Math.floor(qty))
    }
    if (incomingQtyById.size === 0) return fail('BAD_REQUEST', 'Empty items')
    const payment = event.payment || {}
    const paymentMethod = String(payment.method || 'cash')
    const adminConfig = await getOrCreateAdminConfig()
    const deliveryRule = buildDeliveryMinRule(adminConfig)
    try {
      const txRes = await db.runTransaction(async (tx) => {
        let saleDoc = null
        try {
          const saleGet = await tx.collection('sales').doc(sale._id).get()
          saleDoc = saleGet.data
        } catch (err) {
          saleDoc = null
        }
        if (!saleDoc || saleDoc.status !== 'OPEN') throwBiz('NOT_OPEN', 'Not open for ordering')

        const allowed = new Set((saleDoc.dishIds || []).filter(Boolean))
        for (const dishId of incomingQtyById.keys()) {
          if (!allowed.has(dishId)) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
        }

        let existing = null
        try {
          const existingRes = await tx
            .collection('orders')
            .where({
              saleId: saleDoc._id,
              customerOpenId: openId,
              status: _.in([ORDER_STATUS.ACTIVE, ORDER_STATUS.PENDING_REVIEW]),
            })
            .limit(20)
            .get()
          existing = pickLatestOrder(existingRes && existingRes.data)
        } catch (err) {
          existing = null
        }
        const hasEditableExisting = !!existing
        let fulfillmentType = requestedFulfillmentType
        let addressId = requestedAddressId
        let acceptDeliverySlot = requestedAcceptDeliverySlot
        if (hasEditableExisting) {
          const existingFulfillmentType = String(existing.fulfillmentType || '').trim()
          if (existingFulfillmentType && requestedFulfillmentType !== existingFulfillmentType) {
            throwBiz('FULFILLMENT_LOCKED', '已有订单不可修改交货方式')
          }
          if (existingFulfillmentType) fulfillmentType = existingFulfillmentType
          if (fulfillmentType === 'delivery') {
            const existingAddressId = String(existing.addressId || '').trim()
            if (existingAddressId && requestedAddressId && requestedAddressId !== existingAddressId) {
              throwBiz('ADDRESS_LOCKED', '已有订单不可修改地址')
            }
            if (existingAddressId) addressId = existingAddressId
          } else {
            addressId = ''
          }
        }
        if (fulfillmentType === 'delivery') {
          if (!addressId) throwBiz('BAD_REQUEST', '请选择地址')
          if (!hasEditableExisting && !acceptDeliverySlot) {
            throwBiz('DELIVERY_SLOT_NOT_ACCEPTED', 'Delivery slot not accepted')
          }
          if (!String(saleDoc.deliveryTimeSlotLabel || '').trim()) {
            throwBiz('NOT_OPEN', 'Delivery slot not set')
          }
          acceptDeliverySlot = true
        } else {
          addressId = ''
          acceptDeliverySlot = false
        }

        const existingQtyById = new Map()
        const existingStockedQtyById = new Map()
        const existingItemById = new Map()
        if (hasEditableExisting && Array.isArray(existing.items)) {
          for (const oldItem of existing.items) {
            const dishId = String((oldItem && oldItem.dishId) || '').trim()
            const qty = toSafeInt(oldItem && oldItem.qty, 0)
            if (!dishId || qty <= 0) continue
            existingQtyById.set(dishId, qty)
            existingItemById.set(dishId, oldItem)
            if (existing.status === ORDER_STATUS.ACTIVE) existingStockedQtyById.set(dishId, qty)
          }
        }

        const mergedQtyById = new Map(existingQtyById)
        for (const [dishId, qty] of incomingQtyById.entries()) {
          mergedQtyById.set(dishId, (mergedQtyById.get(dishId) || 0) + qty)
        }
        if (mergedQtyById.size === 0) throwBiz('BAD_REQUEST', 'Empty items')

        const mergedDishIds = Array.from(mergedQtyById.keys())
        const dishMap = new Map()
        for (let i = 0; i < mergedDishIds.length; i += 10) {
          const chunk = mergedDishIds.slice(i, i + 10)
          const r = await tx.collection('dishes').where({ _id: _.in(chunk) }).get()
          for (const d of (r.data || [])) dishMap.set(d._id, d)
        }
        for (const dishId of incomingQtyById.keys()) {
          const d = dishMap.get(dishId)
          if (!d || !d.isActive) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
        }

        const orderItems = []
        let totalQty = 0
        let totalAmountCents = 0
        for (const dishId of mergedDishIds) {
          const qty = toSafeInt(mergedQtyById.get(dishId), 0)
          if (qty <= 0) continue
          const dish = dishMap.get(dishId)
          const oldItem = existingItemById.get(dishId) || null
          const unitPriceCents = dish && dish.isActive ? toSafeInt(dish.priceCents, 0) : toSafeInt(oldItem && oldItem.unitPriceCents, 0)
          const dishName = dish ? String(dish.name || '') : String((oldItem && oldItem.dishName) || '')
          if (!dishName) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
          const lineTotalCents = unitPriceCents * qty
          totalQty += qty
          totalAmountCents += lineTotalCents
          orderItems.push({ dishId, dishName, unitPriceCents, qty, lineTotalCents })
        }
        if (orderItems.length === 0) throwBiz('BAD_REQUEST', 'Empty items')

        let addressSnapshot = null
        let orderAddressId = ''
        let orderPhone = ''
        let pendingReason = ''
        let pendingDetail = null
        let minOrderCentsForCity = null
        let customer = null
        try {
          const customerGet = await tx.collection('customers').doc(openId).get()
          customer = customerGet.data
        } catch (err) {
          customer = null
        }
        const addresses = normalizeStoredAddresses(customer && customer.addresses)
        const picked = addressId ? addresses.find((x) => x.id === addressId) || null : null

        if (fulfillmentType === 'delivery') {
          if (!picked) throwBiz('ADDRESS_NOT_FOUND', '请选择有效地址')
          addressSnapshot = {
            label: String(picked.label || '').trim(),
            line1: String(picked.line1 || '').trim(),
            line2: String(picked.line2 || '').trim(),
            postalCode: String(picked.postalCode || '').trim(),
            city: String(picked.city || '').trim(),
            phone: normalizePhone(picked.phone || ''),
            country: 'FR',
          }
          if (!isAddressValid(addressSnapshot)) throwBiz('INVALID_ADDRESS', 'Invalid address')
          orderAddressId = addressId
          orderPhone = normalizePhone(addressSnapshot.phone)
          if (!isPhoneValid(orderPhone)) throwBiz('INVALID_PHONE', 'Invalid phone')

          const cityKey = normalizeCityKey(addressSnapshot.city)
          if (deliveryRule.cityMinMap.has(cityKey)) {
            minOrderCentsForCity = toSafeInt(deliveryRule.cityMinMap.get(cityKey), 0)
          } else if (deliveryRule.defaultMinOrderCents) {
            minOrderCentsForCity = deliveryRule.defaultMinOrderCents
          }
          if (!minOrderCentsForCity) {
            pendingReason = 'CITY_RULE_MISSING'
            pendingDetail = {
              city: addressSnapshot.city,
              postalCode: addressSnapshot.postalCode,
            }
          } else if (totalAmountCents < minOrderCentsForCity) {
            throwBiz('MIN_ORDER_NOT_MET', '未达到该地址起送价', {
              city: addressSnapshot.city,
              totalAmountCents,
              minOrderCents: minOrderCentsForCity,
            })
          }
        } else {
          orderAddressId = ''
          addressSnapshot = null
          if (requestedPhone) {
            if (!isPhoneValid(requestedPhone)) throwBiz('INVALID_PHONE', 'Invalid phone')
            orderPhone = requestedPhone
          } else if (picked && isAddressValid({ ...picked, phone: picked.phone || '' })) {
            orderPhone = normalizePhone(picked.phone || '')
          } else if (existing && existing.contact && isPhoneValid(existing.contact.phone)) {
            orderPhone = normalizePhone(existing.contact.phone)
          } else {
            orderPhone = ''
          }
          if (!isPhoneValid(orderPhone)) throwBiz('INVALID_PHONE', 'Invalid phone')
        }

        const nextStatus = pendingReason ? ORDER_STATUS.PENDING_REVIEW : ORDER_STATUS.ACTIVE
        if (nextStatus === ORDER_STATUS.ACTIVE || (existing && existing.status === ORDER_STATUS.ACTIVE)) {
          const normalizedConfigs = normalizeSaleDishConfigs(saleDoc)
          const configCheck = validateSaleDishConfigs(saleDoc, normalizedConfigs)
          if (!configCheck.ok) throwBiz('SALE_CONFIG_INVALID', configCheck.message)
          const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
          const stockDishIdSet = new Set()
          for (const dishId of mergedDishIds) stockDishIdSet.add(dishId)
          for (const dishId of existingStockedQtyById.keys()) stockDishIdSet.add(dishId)
          const stockDishIds = Array.from(stockDishIdSet)
          const outOfStock = []
          for (const dishId of stockDishIds) {
            const newQty = nextStatus === ORDER_STATUS.ACTIVE ? toSafeInt(mergedQtyById.get(dishId), 0) : 0
            const oldStockedQty = toSafeInt(existingStockedQtyById.get(dishId), 0)
            const delta = newQty - oldStockedQty
            if (delta <= 0) continue
            const cfgItem = cfgMap.get(dishId)
            if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
            const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
            if (delta > remain) {
              outOfStock.push({
                dishId,
                dishName: (dishMap.get(dishId) && dishMap.get(dishId).name) || '',
                remainingQty: remain,
                requiredQty: delta,
              })
            }
          }
          if (outOfStock.length > 0) throwBiz('OUT_OF_STOCK', 'Out of stock', { items: outOfStock })

          let stockChanged = false
          for (const dishId of stockDishIds) {
            const newQty = nextStatus === ORDER_STATUS.ACTIVE ? toSafeInt(mergedQtyById.get(dishId), 0) : 0
            const oldStockedQty = toSafeInt(existingStockedQtyById.get(dishId), 0)
            const delta = newQty - oldStockedQty
            if (delta === 0) continue
            const cfgItem = cfgMap.get(dishId)
            if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
            cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + delta)
            cfgMap.set(dishId, cfgItem)
            stockChanged = true
          }
          if (stockChanged) {
            const updatedConfigs = normalizedConfigs.map((x) => {
              const cur = cfgMap.get(x.dishId)
              return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
            })
            await tx.collection('sales').doc(saleDoc._id).update({
              data: { dishConfigs: updatedConfigs, updatedAt: db.serverDate() },
            })
          }
        }

        const paidStatus = String((existing && existing.payment && existing.payment.paidStatus) || '') === 'PAID' ? 'PAID' : 'UNPAID'
        const now = db.serverDate()
        const doc = {
          saleId: saleDoc._id,
          customerOpenId: openId,
          status: nextStatus,
          fulfillmentType,
          deliveryTimeSlotLabelSnapshot: fulfillmentType === 'delivery' ? String(saleDoc.deliveryTimeSlotLabel || '').trim() : null,
          acceptDeliverySlot,
          contact: { phone: orderPhone },
          addressId: fulfillmentType === 'delivery' ? orderAddressId || null : null,
          address:
            fulfillmentType === 'delivery'
              ? {
                  label: String((addressSnapshot && addressSnapshot.label) || '').trim(),
                  line1: String((addressSnapshot && addressSnapshot.line1) || '').trim(),
                  line2: String((addressSnapshot && addressSnapshot.line2) || '').trim(),
                  postalCode: String((addressSnapshot && addressSnapshot.postalCode) || '').trim(),
                  city: String((addressSnapshot && addressSnapshot.city) || '').trim(),
                  country: 'FR',
                }
              : null,
          minOrderCentsSnapshot: fulfillmentType === 'delivery' ? minOrderCentsForCity || null : null,
          payment: { method: paymentMethod, paidStatus },
          remark: String(event.remark || '').trim(),
          items: orderItems,
          totals: { qty: totalQty, amountCents: totalAmountCents },
          saleConfigVersionSnapshot: nextStatus === ORDER_STATUS.ACTIVE ? toSafeInt(saleDoc.saleConfigVersion, 0) : 0,
          updatedAt: now,
        }
        const auditAction =
          nextStatus === ORDER_STATUS.PENDING_REVIEW
            ? existing
              ? 'UPDATE_PENDING'
              : 'CREATE_PENDING'
            : existing
              ? 'UPDATE'
              : 'CREATE'
        let currentOrderId = String((existing && existing._id) || '').trim()
        if (existing) {
          const updateData = {
            ...doc,
            cancelledAt: _.remove,
            cancelledByOpenId: _.remove,
            rejectedAt: _.remove,
            rejectedByOpenId: _.remove,
            rejectedReason: _.remove,
            approvedAt: nextStatus === ORDER_STATUS.ACTIVE ? now : _.remove,
          }
          if (nextStatus === ORDER_STATUS.PENDING_REVIEW) {
            updateData.pendingReason = pendingReason
            updateData.pendingDetail = pendingDetail
            updateData.pendingAt =
              existing.status === ORDER_STATUS.PENDING_REVIEW && existing.pendingAt ? existing.pendingAt : now
          } else {
            updateData.pendingReason = _.remove
            updateData.pendingDetail = _.remove
            updateData.pendingAt = _.remove
          }
          await tx.collection('orders').doc(currentOrderId).update({
            data: updateData,
          })
        } else {
          const setDoc = {
            ...doc,
            createdAt: now,
          }
          if (nextStatus === ORDER_STATUS.PENDING_REVIEW) {
            setDoc.pendingReason = pendingReason
            setDoc.pendingDetail = pendingDetail
            setDoc.pendingAt = now
          } else {
            setDoc.approvedAt = now
          }
          const addRes = await tx.collection('orders').add({
            data: setDoc,
          })
          currentOrderId = String((addRes && addRes._id) || '').trim()
          if (!currentOrderId) throwBiz('TX_FAILED', 'Create order failed')
        }
        await tx.collection('orderAuditLogs').add({
          data: {
            orderId: currentOrderId,
            action: auditAction,
            byOpenId: openId,
            at: now,
          },
        })
        return { orderId: currentOrderId, mode: auditAction, status: nextStatus }
      })
      return ok({
        orderId: txRes && txRes.orderId ? txRes.orderId : '',
        mode: txRes && txRes.mode ? txRes.mode : 'UPDATE',
        status: txRes && txRes.status ? txRes.status : ORDER_STATUS.ACTIVE,
      })
    } catch (err) {
      if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
      return fail('TX_FAILED', 'Create order failed', String(err && err.message))
    }
  }

  return fail('UNKNOWN_ACTION', `Unknown action: ${action || ''}`)
}
