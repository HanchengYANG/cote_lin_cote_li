function createConfigService(deps) {
  const {
    db,
    ok,
    normalizeDeliveryMinByCity,
    toSafeInt,
    getOrCreateAdminConfig,
  } = deps

  return {
    async getDeliveryRules() {
      const cfg = await getOrCreateAdminConfig()
      const deliveryMinByCity = normalizeDeliveryMinByCity(cfg && cfg.deliveryMinByCity)
      const deliveryMinDefaultCents = toSafeInt(cfg && cfg.deliveryMinDefaultCents, 0)
      return ok({
        deliveryMinByCity,
        deliveryMinDefaultCents: deliveryMinDefaultCents > 0 ? deliveryMinDefaultCents : 0,
      })
    },

    async updateDeliveryRules(event) {
      const incomingMap = normalizeDeliveryMinByCity(event && event.deliveryMinByCity)
      const defaultCentsRaw = toSafeInt(event && event.deliveryMinDefaultCents, 0)
      const deliveryMinDefaultCents = defaultCentsRaw > 0 ? defaultCentsRaw : 0
      await db.collection('delivery_rules').doc('main').set({
        data: {
          deliveryMinByCity: incomingMap,
          deliveryMinDefaultCents,
          updatedAt: db.serverDate(),
        },
      })
      return ok({})
    },
  }
}

module.exports = {
  createConfigService,
}
