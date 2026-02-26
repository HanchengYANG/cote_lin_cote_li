function stripPhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '')
}

function normalizePhone(phone) {
  return stripPhoneDigits(phone)
}

function normalizePhoneInputDigits(phone) {
  return stripPhoneDigits(phone).slice(0, 10)
}

function isPhoneValid(phone) {
  return /^\d{10}$/.test(normalizePhone(phone))
}

function formatPhoneDisplay(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return ''
  const digits = normalizePhone(raw)
  if (!/^\d{10}$/.test(digits)) return raw
  return digits.replace(/(\d{2})(?=\d)/g, '$1 ').trim()
}

function formatPhoneBlurValue(phone) {
  const digits = normalizePhoneInputDigits(phone)
  if (!digits) return ''
  return /^\d{10}$/.test(digits) ? formatPhoneDisplay(digits) : digits
}

module.exports = {
  normalizePhone,
  normalizePhoneInputDigits,
  isPhoneValid,
  formatPhoneDisplay,
  formatPhoneBlurValue,
}
