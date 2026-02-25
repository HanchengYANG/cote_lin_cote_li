const { createCustomerOrderService } = require('../services/order-service')

function createOrderHandlers(deps) {
  return createCustomerOrderService(deps)
}

module.exports = {
  createOrderHandlers,
}
