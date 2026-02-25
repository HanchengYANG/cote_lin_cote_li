const { createSaleService } = require('../services/sale-service.js')

function createSaleHandlers(deps) {
  return createSaleService(deps)
}

module.exports = {
  createSaleHandlers,
}
