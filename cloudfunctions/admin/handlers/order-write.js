const { createOrderWriteService } = require('../services/order-write-service.js')

function createOrderWriteHandlers(deps) {
  return createOrderWriteService(deps)
}

module.exports = {
  createOrderWriteHandlers,
}
