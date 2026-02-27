const { wxp } = require('./wxprom')

const BASE_URL = 'https://api-adresse.data.gouv.fr/search/'

function normalizeLimit(limit, fallback = 1) {
  const n = Number(limit)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(5, Math.floor(n)))
}

function parseCoordinateFromFeature(feature) {
  const geometry = (feature && feature.geometry) || {}
  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : []
  const longitude = Number(coords[0])
  const latitude = Number(coords[1])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90) return null
  if (longitude < -180 || longitude > 180) return null
  return { latitude, longitude }
}

async function geocodeAddressDirect(q, limit = 1) {
  const query = String(q || '').trim()
  if (query.length < 3) return { ok: false, code: 'BAD_QUERY', message: 'Address query too short' }
  const n = normalizeLimit(limit, 1)
  try {
    const res = await wxp(wx.request, {
      url: `${BASE_URL}?q=${encodeURIComponent(query)}&limit=${n}`,
      method: 'GET',
      timeout: 4500,
      header: { Accept: 'application/json' },
    })
    const statusCode = Number(res && res.statusCode)
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      return { ok: false, code: 'HTTP_ERROR', message: `HTTP_${statusCode || 'ERR'}` }
    }
    const data = (res && res.data) || {}
    const features = Array.isArray(data.features) ? data.features : []
    for (const feature of features) {
      const coordinate = parseCoordinateFromFeature(feature)
      if (!coordinate) continue
      const props = (feature && feature.properties) || {}
      return {
        ok: true,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        matchedLabel: String(props.label || '').trim(),
      }
    }
    return { ok: false, code: 'NO_COORDINATE', message: 'No coordinate resolved' }
  } catch (err) {
    return { ok: false, code: 'REQUEST_FAILED', message: 'REQUEST_FAILED', detail: err }
  }
}

module.exports = {
  geocodeAddressDirect,
}
