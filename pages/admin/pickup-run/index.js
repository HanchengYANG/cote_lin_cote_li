const { createRunPage } = require('../run-page-factory')

createRunPage({
  listSalesAction: 'listPickupSales',
  getRunAction: 'getPickupRun',
  enableGoogleNav: false,
  splitByDelivered: true,
  preferredStatuses: ['OPEN', 'CLOSED', 'FULFILLING'],
})
