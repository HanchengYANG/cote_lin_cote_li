const crypto = require('crypto')

function buildAddressId() {
  return `addr_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
}

function toSafeInt(v, fallback = 0) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

function toTimeMs(v) {
  if (!v) return 0
  const d = new Date(v)
  const t = d.getTime()
  return Number.isFinite(t) ? t : 0
}

function pickLatestOrder(orders) {
  const arr = Array.isArray(orders) ? orders.filter(Boolean) : []
  if (arr.length <= 1) return arr[0] || null
  arr.sort((a, b) => {
    const ta = toTimeMs(a && (a.updatedAt || a.createdAt))
    const tb = toTimeMs(b && (b.updatedAt || b.createdAt))
    return tb - ta
  })
  return arr[0] || null
}

function normalizeCityKey(city) {
  return String(city || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '')
}

function isPhoneValid(phone) {
  return /^\d{10}$/.test(normalizePhone(phone))
}

function isAddressValid(addr) {
  if (!addr) return false
  const line1 = String(addr.line1 || '').trim()
  const postalCode = String(addr.postalCode || '').trim()
  const city = String(addr.city || '').trim()
  const phone = normalizePhone(addr.phone || '')
  const country = String(addr.country || 'FR').trim().toUpperCase()
  if (!line1 || !city) return false
  if (!/^\d{5}$/.test(postalCode)) return false
  if (!isPhoneValid(phone)) return false
  if (country !== 'FR') return false
  return true
}

function normalizeAddressPayload(input, options = {}) {
  const source = input || {}
  const line1 = String(source.line1 || '').trim()
  const line2 = String(source.line2 || '').trim()
  const postalCode = String(source.postalCode || '').trim()
  const city = String(source.city || '').trim()
  const phone = normalizePhone(source.phone || '')
  const country = String(source.country || 'FR')
    .trim()
    .toUpperCase()
  const labelRaw = String(source.label || '').trim()
  const label = labelRaw || `${line1} ${city}`.trim()
  const out = {
    label: label.slice(0, 40),
    line1,
    line2,
    postalCode,
    city,
    phone,
    country: country || 'FR',
  }
  if (!isAddressValid(out)) return null
  if (options.requireLabel && !out.label) return null
  return out
}

function normalizeStoredAddresses(input) {
  const arr = Array.isArray(input) ? input : []
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const normalized = normalizeAddressPayload(raw, { requireLabel: true })
    if (!normalized) continue
    const id = String((raw && (raw.id || raw._id)) || '').trim() || buildAddressId()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      ...normalized,
      createdAtMs: toSafeInt(raw && raw.createdAtMs, Date.now()),
      updatedAtMs: toSafeInt(raw && raw.updatedAtMs, Date.now()),
    })
  }
  return out
}

function sanitizeProfileNickname(input) {
  return String(input || '').trim().slice(0, 40)
}

function normalizeProfilePhone(input) {
  const phone = normalizePhone(input)
  if (!phone) return ''
  return isPhoneValid(phone) ? phone : ''
}

function toProfileOutput(doc) {
  const nickname = sanitizeProfileNickname(doc && doc.nickname)
  const addresses = normalizeStoredAddresses(doc && doc.addresses)
  const profilePhone = normalizeProfilePhone(doc && doc.profilePhone)
  let defaultAddressId = String((doc && doc.defaultAddressId) || '').trim()
  if (!addresses.some((a) => a.id === defaultAddressId)) {
    defaultAddressId = addresses[0] ? addresses[0].id : ''
  }
  return {
    nickname,
    profilePhone,
    defaultAddressId,
    addresses,
    isComplete: !!nickname,
  }
}

function toProfileSummary(doc) {
  const profile = toProfileOutput(doc)
  return {
    nickname: profile.nickname,
    profilePhone: profile.profilePhone,
    defaultAddressId: profile.defaultAddressId,
    addressCount: profile.addresses.length,
    isComplete: profile.isComplete,
  }
}

function buildDeliveryMinRule(config) {
  const raw = config && typeof config.deliveryMinByCity === 'object' && config.deliveryMinByCity ? config.deliveryMinByCity : {}
  const cityMinMap = new Map()
  for (const key of Object.keys(raw)) {
    const minOrderCents = toSafeInt(raw[key], NaN)
    if (!Number.isFinite(minOrderCents) || minOrderCents <= 0) continue
    cityMinMap.set(normalizeCityKey(key), minOrderCents)
  }
  const defaultMinOrderCents = toSafeInt(config && config.deliveryMinDefaultCents, NaN)
  return {
    cityMinMap,
    defaultMinOrderCents: Number.isFinite(defaultMinOrderCents) && defaultMinOrderCents > 0 ? defaultMinOrderCents : null,
  }
}

function attachMinOrderInfo(profile, deliveryRule) {
  const p = profile || { nickname: '', profilePhone: '', defaultAddressId: '', addresses: [], isComplete: false }
  const rule = deliveryRule || { cityMinMap: new Map(), defaultMinOrderCents: null }
  const addresses = (p.addresses || []).map((a) => {
    const cityKey = normalizeCityKey(a.city)
    let minOrderCents = 0
    if (rule.cityMinMap.has(cityKey)) {
      minOrderCents = toSafeInt(rule.cityMinMap.get(cityKey), 0)
    } else if (rule.defaultMinOrderCents) {
      minOrderCents = rule.defaultMinOrderCents
    }
    return {
      ...a,
      minOrderCents,
    }
  })
  return { ...p, addresses }
}

module.exports = {
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
  normalizeProfilePhone,
  toProfileOutput,
  toProfileSummary,
  buildDeliveryMinRule,
  attachMinOrderInfo,
}
