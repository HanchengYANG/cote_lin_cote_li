function createCustomerRuntimeConfigRepo(deps) {
  const { db } = deps

  async function getOrCreateRuntimeState() {
    const ref = db.collection('system_runtime_state').doc('main')
    try {
      const r = await ref.get()
      return r.data || { currentSaleId: null }
    } catch (err) {
      await ref.set({
        data: {
          currentSaleId: null,
          updatedAt: db.serverDate(),
        },
      })
      const r2 = await ref.get()
      return r2.data || { currentSaleId: null }
    }
  }

  async function getOrCreateDeliveryRulesDoc() {
    const ref = db.collection('delivery_rules').doc('main')
    try {
      const r = await ref.get()
      return r.data || { deliveryMinByCity: {}, deliveryMinDefaultCents: 0 }
    } catch (err) {
      await ref.set({
        data: {
          deliveryMinByCity: {},
          deliveryMinDefaultCents: 0,
          updatedAt: db.serverDate(),
        },
      })
      const r2 = await ref.get()
      return r2.data || { deliveryMinByCity: {}, deliveryMinDefaultCents: 0 }
    }
  }

  async function getOrCreateAdminConfig() {
    const [runtime, rules] = await Promise.all([getOrCreateRuntimeState(), getOrCreateDeliveryRulesDoc()])
    return {
      currentSaleId: (runtime && runtime.currentSaleId) || null,
      deliveryMinByCity: (rules && rules.deliveryMinByCity) || {},
      deliveryMinDefaultCents: Number((rules && rules.deliveryMinDefaultCents) || 0) || 0,
    }
  }

  return {
    getOrCreateRuntimeState,
    getOrCreateDeliveryRulesDoc,
    getOrCreateAdminConfig,
  }
}

module.exports = {
  createCustomerRuntimeConfigRepo,
}
