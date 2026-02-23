const { createDishService } = require('../services/dish-service.js')

function createDishHandlers(deps) {
  return createDishService(deps)
}

module.exports = {
  createDishHandlers,
}
