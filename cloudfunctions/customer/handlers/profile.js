const { createProfileService } = require('../services/profile-service.js')

function createProfileHandlers(deps) {
  return createProfileService(deps)
}

module.exports = {
  createProfileHandlers,
}
