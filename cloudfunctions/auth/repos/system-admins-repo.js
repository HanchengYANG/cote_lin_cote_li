function createAuthSystemAdminsRepo(deps) {
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

  return {
    getOrCreateSystemAdmins,
  }
}

module.exports = {
  createAuthSystemAdminsRepo,
}

