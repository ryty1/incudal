import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import type { SshKey } from '@/types/api'

type HostingZone = Awaited<ReturnType<typeof api.packages.getHostingZones>>['zones'][number]

const SSH_KEYS_TTL = 60_000 // 60 seconds
const HOSTING_ZONES_TTL = 120_000 // 120 seconds

export const useInstanceResourcesStore = defineStore('instanceResources', () => {
  const sshKeys = ref<SshKey[]>([])
  const hostingZones = ref<HostingZone[]>([])

  let sshKeysLoadPromise: Promise<void> | null = null
  let sshKeysLoadedAt = 0

  let hostingZonesLoadPromise: Promise<void> | null = null
  let hostingZonesLoadedAt = 0

  async function loadSshKeys(force = false): Promise<void> {
    if (!force && sshKeysLoadPromise) return sshKeysLoadPromise
    if (!force && Date.now() - sshKeysLoadedAt < SSH_KEYS_TTL) return

    sshKeysLoadPromise = (async () => {
      try {
        const res = await api.sshKeys.list()
        sshKeys.value = res.keys || []
        sshKeysLoadedAt = Date.now()
      } catch (error) {
        console.error('Failed to load SSH keys:', error)
      } finally {
        sshKeysLoadPromise = null
      }
    })()

    return sshKeysLoadPromise
  }

  async function loadHostingZones(force = false): Promise<void> {
    if (!force && hostingZonesLoadPromise) return hostingZonesLoadPromise
    if (!force && Date.now() - hostingZonesLoadedAt < HOSTING_ZONES_TTL) return

    hostingZonesLoadPromise = (async () => {
      try {
        const res = await api.packages.getHostingZones()
        hostingZones.value = res.zones || []
        hostingZonesLoadedAt = Date.now()
      } catch (error) {
        console.error('Failed to load hosting zones:', error)
      } finally {
        hostingZonesLoadPromise = null
      }
    })()

    return hostingZonesLoadPromise
  }

  return {
    sshKeys,
    hostingZones,
    loadSshKeys,
    loadHostingZones
  }
})
