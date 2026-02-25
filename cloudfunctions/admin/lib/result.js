function ok(data) {
  return { ok: true, data }
}

function fail(code, message, detail) {
  return { ok: false, code, message, detail }
}

module.exports = {
  ok,
  fail,
}
