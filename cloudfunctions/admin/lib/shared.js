const crypto = require('crypto')

function toSafeInt(v, fallback = 0) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

function normalizeDeliveryMinByCity(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of Object.keys(raw)) {
    const city = String(key || '')
    if (!city.trim()) continue
    const cents = toSafeInt(raw[key], NaN)
    if (!Number.isFinite(cents) || cents <= 0) continue
    out[city] = cents
  }
  return out
}

function buildOrderId(saleId, openId) {
  return crypto.createHash('md5').update(`${String(saleId || '')}:${String(openId || '')}`).digest('hex')
}

function parseAndValidateDeliverySlot(event) {
  const deliverySlotDate = event.deliverySlotDate ? String(event.deliverySlotDate).trim() : ''
  const deliverySlotStartTime = event.deliverySlotStartTime ? String(event.deliverySlotStartTime).trim() : ''
  const deliverySlotEndTime = event.deliverySlotEndTime ? String(event.deliverySlotEndTime).trim() : ''
  if (!(deliverySlotDate && deliverySlotStartTime && deliverySlotEndTime)) {
    return { ok: false, message: 'Missing structured slot fields' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deliverySlotDate)) return { ok: false, message: 'Invalid slot date' }
  if (!/^\d{2}:\d{2}$/.test(deliverySlotStartTime)) return { ok: false, message: 'Invalid slot start time' }
  if (!/^\d{2}:\d{2}$/.test(deliverySlotEndTime)) return { ok: false, message: 'Invalid slot end time' }
  if (deliverySlotStartTime >= deliverySlotEndTime) return { ok: false, message: 'Invalid slot time range' }
  return {
    ok: true,
    deliverySlotDate,
    deliverySlotStartTime,
    deliverySlotEndTime,
    deliveryTimeSlotLabel: `${deliverySlotDate} ${deliverySlotStartTime}-${deliverySlotEndTime}`,
  }
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '')
}

function isPhoneValid(phone) {
  return /^\d{10}$/.test(normalizePhone(phone))
}

function normalizeAddressPayload(input) {
  const source = input || {}
  const line1 = String(source.line1 || '').trim()
  const line2 = String(source.line2 || '').trim()
  const postalCode = String(source.postalCode || '').trim()
  const city = String(source.city || '').trim()
  const country = String(source.country || 'FR')
    .trim()
    .toUpperCase()
  const label = String(source.label || '').trim().slice(0, 40)
  if (!line1 || !city) return null
  if (!/^\d{5}$/.test(postalCode)) return null
  if ((country || 'FR') !== 'FR') return null
  return {
    label,
    line1,
    line2,
    postalCode,
    city,
    country: 'FR',
  }
}

function normalizeStoredAddresses(input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()
  for (const raw of arr) {
    const normalized = normalizeAddressPayload(raw)
    if (!normalized) continue
    const id = String((raw && raw.id) || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      ...normalized,
      phone: normalizePhone(raw && raw.phone),
    })
  }
  return out
}

function extractOrderAddressSnapshot(input) {
  const normalized = normalizeAddressPayload(input)
  if (!normalized) return null
  return {
    label: normalized.label,
    line1: normalized.line1,
    line2: normalized.line2,
    postalCode: normalized.postalCode,
    city: normalized.city,
    country: 'FR',
  }
}

function formatOrderAddress(a) {
  if (!a) return ''
  const parts = [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean)
  return parts.join(' ')
}

function normalizeDishConfigs(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    const dishId = String((raw && raw.dishId) || '').trim()
    if (!dishId || seen.has(dishId)) continue
    const limitQty = toSafeInt(raw && raw.limitQty, NaN)
    if (!Number.isFinite(limitQty) || limitQty < 0) continue
    const soldRaw = toSafeInt(raw && raw.soldQty, 0)
    const soldQty = Math.max(0, Math.min(limitQty, soldRaw))
    out.push({ dishId, limitQty, soldQty })
    seen.add(dishId)
  }
  return out
}

function dishConfigMap(dishConfigs) {
  const m = new Map()
  for (const cfg of normalizeDishConfigs(dishConfigs)) {
    m.set(cfg.dishId, cfg)
  }
  return m
}

function normalizeOrderItems(items) {
  const arr = Array.isArray(items) ? items : []
  const out = []
  for (const it of arr) {
    const dishId = String((it && it.dishId) || '').trim()
    const qty = toSafeInt(it && it.qty, 0)
    if (!dishId || qty <= 0) continue
    out.push({ dishId, qty })
  }
  return out
}

module.exports = {
  toSafeInt,
  normalizeDeliveryMinByCity,
  buildOrderId,
  parseAndValidateDeliverySlot,
  normalizePhone,
  isPhoneValid,
  normalizeAddressPayload,
  normalizeStoredAddresses,
  extractOrderAddressSnapshot,
  formatOrderAddress,
  normalizeDishConfigs,
  dishConfigMap,
  normalizeOrderItems,
}
