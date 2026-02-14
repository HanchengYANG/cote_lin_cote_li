function normalizePhone(phone) {
  return String(phone || '')
    .trim()
    .replace(/[.\-\s]/g, '')
}

function isPhoneValid(phone) {
  return /^(\+?\d{6,20})$/.test(normalizePhone(phone))
}

module.exports = {
  normalizePhone,
  isPhoneValid,
}
