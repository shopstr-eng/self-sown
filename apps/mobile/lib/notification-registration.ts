import {
  isMobileNotificationId,
  isNotificationCapability,
  type NotificationRegistration,
} from "@self-sown/domain";
export interface DeviceRevocation {
  deviceId: string;
  revocationCapability: string;
}
export interface DeviceRegistrationState {
  installationId: string;
  enabledFor?: string;
  active?: DeviceRevocation & { seller: string };
  pending: DeviceRevocation[];
}
interface Dependencies {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
  randomId: () => string;
  register: (
    installationId: string,
    seller: string
  ) => Promise<NotificationRegistration>;
  revoke: (device: DeviceRevocation) => Promise<void>;
  onChange: () => void;
}
function validRevocation(value: unknown): value is DeviceRevocation {
  if (!value || typeof value !== "object") return false;
  const item = value as DeviceRevocation;
  return (
    isMobileNotificationId(item.deviceId) &&
    isNotificationCapability(item.revocationCapability)
  );
}
export function createDeviceRegistrationController(deps: Dependencies) {
  let state: DeviceRegistrationState | undefined;
  let epoch = 0;
  let registration: Promise<void> | undefined;
  let flushing: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  async function read(): Promise<DeviceRegistrationState> {
    if (state) return state;
    const raw = await deps.read();
    if (state) return state;
    if (raw) {
      const value = JSON.parse(raw) as DeviceRegistrationState;
      if (
        !isMobileNotificationId(value.installationId) ||
        !Array.isArray(value.pending) ||
        !value.pending.every(validRevocation) ||
        (value.active &&
          (!validRevocation(value.active) ||
            !/^[0-9a-f]{64}$/.test(value.active.seller))) ||
        (value.enabledFor && !/^[0-9a-f]{64}$/.test(value.enabledFor))
      )
        throw new Error("Notification settings could not be restored.");
      state = value;
    } else state = { installationId: deps.randomId(), pending: [] };
    return state;
  }
  async function change(update: (s: DeviceRegistrationState) => void) {
    const work = writes.then(async () => {
      const current = await read();
      const next: DeviceRegistrationState = {
        ...current,
        pending: [...current.pending],
      };
      update(next);
      await deps.write(JSON.stringify(next));
      state = next;
      deps.onChange();
    });
    writes = work.catch(() => {});
    await work;
  }
  async function flushRevocations() {
    if (flushing) return flushing;
    flushing = (async () => {
      const pending = [...(await read()).pending];
      for (const item of pending) {
        try {
          await deps.revoke(item);
        } catch {
          continue;
        }
        await change((s) => {
          s.pending = s.pending.filter(
            (d) =>
              d.deviceId !== item.deviceId ||
              d.revocationCapability !== item.revocationCapability
          );
        });
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = undefined;
    }
  }
  async function renew(seller: string) {
    if (registration) return registration;
    const version = epoch;
    registration = (async () => {
      await flushRevocations();
      const current = await read();
      if (current.enabledFor !== seller || version !== epoch) return;
      const result = await deps.register(current.installationId, seller);
      await change((s) => {
        if (version !== epoch || s.enabledFor !== seller) {
          s.pending.push({
            deviceId: result.deviceId,
            revocationCapability: result.revocationCapability,
          });
          return;
        }
        s.active = {
          deviceId: result.deviceId,
          revocationCapability: result.revocationCapability,
          seller,
        };
      });
      await flushRevocations();
    })();
    try {
      await registration;
    } finally {
      registration = undefined;
    }
  }
  async function disable() {
    epoch++;
    await change((s) => {
      delete s.enabledFor;
      if (s.active)
        s.pending.push({
          deviceId: s.active.deviceId,
          revocationCapability: s.active.revocationCapability,
        });
      delete s.active;
    });
  }
  return {
    read,
    renew,
    disable,
    flushRevocations,
    async enable(seller: string) {
      if (!/^[0-9a-f]{64}$/.test(seller))
        throw new Error("Seller session required.");
      epoch++;
      await change((s) => {
        if (s.active && s.active.seller !== seller) {
          s.pending.push({
            deviceId: s.active.deviceId,
            revocationCapability: s.active.revocationCapability,
          });
          delete s.active;
        }
        s.enabledFor = seller;
      });
      await renew(seller);
    },
  };
}
