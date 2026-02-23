const { createAddressService } = require('../services/address-service.js')

function createAddressHandlers(deps) {
  return createAddressService(deps)
}

module.exports = {
  createAddressHandlers,
}
