const { normalizePhone, isPhoneValid } = require('./phone')

function normalizeFrAddress(input, options = {}) {
  const source = input || {}
  const line1 = String(source.line1 || '').trim()
  const line2 = String(source.line2 || '').trim()
  const postalCode = String(source.postalCode || '').trim()
  const city = String(source.city || '').trim()
  const country = String(source.country || 'FR')
    .trim()
    .toUpperCase()
  const label = String(source.label || '').trim()
  const phone = normalizePhone(source.phone || '')
  const out = {
    label,
    line1,
    line2,
    postalCode,
    city,
    phone,
    country: country || 'FR',
  }
  if (options.requireLabel && !out.label) return null
  return out
}

function isFrAddressValid(input, options = {}) {
  const addr = normalizeFrAddress(input, options)
  if (!addr) return false
  if (!addr.line1 || !addr.city) return false
  if (options.requireLabel && !addr.label) return false
  if (!/^\d{5}$/.test(addr.postalCode)) return false
  if (options.requirePhone && !isPhoneValid(addr.phone)) return false
  if (String(addr.country || 'FR').toUpperCase() !== 'FR') return false
  return true
}

module.exports = {
  normalizeFrAddress,
  isFrAddressValid,
}
