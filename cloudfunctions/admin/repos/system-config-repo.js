function createAdminSystemConfigRepo(deps) {
  const { db } = deps

  async function getOrCreateSystemAdmins() {
    const ref = db.collection('system_admins').doc('main')
    try {
      const r = await ref.get()
      return r.data || { adminOpenIds: [] }
    } catch (err) {
      await ref.set({
        data: {
          adminOpenIds: [],
          updatedAt: db.serverDate(),
        },
      })
      const r2 = await ref.get()
      return r2.data || { adminOpenIds: [] }
    }
  }

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
    const [admins, runtime, rules] = await Promise.all([
      getOrCreateSystemAdmins(),
      getOrCreateRuntimeState(),
      getOrCreateDeliveryRulesDoc(),
    ])
    return {
      adminOpenIds: Array.isArray(admins && admins.adminOpenIds) ? admins.adminOpenIds : [],
      currentSaleId: (runtime && runtime.currentSaleId) || null,
      deliveryMinByCity: (rules && rules.deliveryMinByCity) || {},
      deliveryMinDefaultCents: Number((rules && rules.deliveryMinDefaultCents) || 0) || 0,
    }
  }

  async function getOrCreateRuntimeStateTx(tx) {
    const ref = tx.collection('system_runtime_state').doc('main')
    try {
      const r = await ref.get()
      return { ref, data: (r && r.data) || { currentSaleId: null } }
    } catch (err) {
      await ref.set({
        data: {
          currentSaleId: null,
          updatedAt: db.serverDate(),
        },
      })
      const r2 = await ref.get()
      return { ref, data: (r2 && r2.data) || { currentSaleId: null } }
    }
  }

  return {
    getOrCreateSystemAdmins,
    getOrCreateRuntimeState,
    getOrCreateDeliveryRulesDoc,
    getOrCreateAdminConfig,
    getOrCreateRuntimeStateTx,
  }
}

module.exports = {
  createAdminSystemConfigRepo,
}
