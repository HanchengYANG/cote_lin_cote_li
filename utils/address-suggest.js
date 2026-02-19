const { wxp } = require('./wxprom')

const BASE_URL = 'https://api-adresse.data.gouv.fr/search/'

function normalizeLimit(limit, fallback = 5) {
  const n = Number(limit)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(10, Math.floor(n)))
}

function buildSuggestionLine1(props) {
  const p = props || {}
  const house = String(p.housenumber || '').trim()
  const street = String(p.street || p.name || '').trim()
  let line1 = street
  if (house) {
    const lowHouse = house.toLowerCase()
    const tokens = street.split(/\s+/).filter(Boolean)
    const startsWithHouse = tokens.length > 0 && String(tokens[0] || '').toLowerCase() === lowHouse
    line1 = startsWithHouse ? street : `${house} ${street}`.trim()
  }
  if (!line1) line1 = String(p.label || '').trim()
  const parts = line1.split(/\s+/).filter(Boolean)
  if (parts.length >= 2 && String(parts[0]).toLowerCase() === String(parts[1]).toLowerCase()) {
    parts.splice(1, 1)
    line1 = parts.join(' ')
  }
  return String(line1 || '').trim()
}

function mapFeatureToSuggestion(feature) {
  const p = (feature && feature.properties) || {}
  const line1 = buildSuggestionLine1(p)
  return {
    label: String(p.label || line1).trim(),
    line1,
    postalCode: String(p.postcode || '').trim(),
    city: String(p.city || '').trim(),
  }
}

function dedupeSuggestions(input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()
  for (const item of arr) {
    const key = `${item.line1}|${item.postalCode}|${item.city}`.toLowerCase()
    if (!item.line1 || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

async function suggestAddressDirect(q, limit = 5) {
  const query = String(q || '').trim()
  if (query.length < 3) return { ok: true, suggestions: [] }
  const n = normalizeLimit(limit, 5)
  try {
    const res = await wxp(wx.request, {
      url: `${BASE_URL}?q=${encodeURIComponent(query)}&limit=${n}`,
      method: 'GET',
      timeout: 4500,
      header: {
        Accept: 'application/json',
      },
    })
    const statusCode = Number(res && res.statusCode)
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      return { ok: false, code: 'HTTP_ERROR', message: `HTTP_${statusCode || 'ERR'}`, suggestions: [] }
    }
    const data = (res && res.data) || {}
    const features = Array.isArray(data.features) ? data.features : []
    const suggestions = dedupeSuggestions(features.map(mapFeatureToSuggestion))
    return { ok: true, suggestions }
  } catch (err) {
    return { ok: false, code: 'REQUEST_FAILED', message: 'REQUEST_FAILED', detail: err, suggestions: [] }
  }
}

module.exports = {
  suggestAddressDirect,
}
