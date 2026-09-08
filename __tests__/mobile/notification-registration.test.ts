/** @jest-environment node */
import { createDeviceRegistrationController } from "../../apps/mobile/lib/notification-registration";
const id = "60c6f74b-9ce0-4dad-a888-1d9ac30f035b";
const registration = {
  deviceId: id,
  enabled: true,
  generation: 1,
  revocationCapability: "c".repeat(64),
};
function setup() {
  let stored: string | null = null;
  const deps = {
    read: async () => stored,
    write: jest.fn(async (value: string) => {
      stored = value;
    }),
    randomId: () => id,
    register: jest.fn(async () => registration),
    revoke: jest.fn(async () => {}),
    onChange: jest.fn(),
  };
  return { deps, controller: createDeviceRegistrationController(deps) };
}
test("permission opt-in persists only registration capabilities, never seller secret or token", async () => {
  const { deps, controller } = setup();
  await controller.enable("a".repeat(64));
  expect((await controller.read()).active?.deviceId).toBe(id);
  expect(deps.register).toHaveBeenCalledWith(id, "a".repeat(64));
});
test("offline disable persists device-only revocation and retries after restart", async () => {
  const { deps, controller } = setup();
  await controller.enable("a".repeat(64));
  deps.revoke.mockRejectedValueOnce(new Error("offline"));
  await controller.disable();
  await controller.flushRevocations();
  expect((await controller.read()).active).toBeUndefined();
  expect((await controller.read()).pending).toHaveLength(1);
  const restarted = createDeviceRegistrationController(deps);
  await restarted.flushRevocations();
  expect((await restarted.read()).pending).toHaveLength(0);
});
test("logout during confirmation revokes the late result without re-enabling alerts", async () => {
  const { deps, controller } = setup();
  let complete!: (value: typeof registration) => void;
  deps.register.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const enabling = controller.enable("a".repeat(64));
  await new Promise((resolve) => setImmediate(resolve));
  expect(complete).toBeDefined();
  await controller.disable();
  complete(registration);
  await enabling;
  expect((await controller.read()).active).toBeUndefined();
  expect((await controller.read()).enabledFor).toBeUndefined();
  expect(deps.revoke).toHaveBeenCalledWith(
    expect.objectContaining({
      deviceId: id,
      revocationCapability: registration.revocationCapability,
    })
  );
});
test("renewal never registers a different account without its opt-in", async () => {
  const { deps, controller } = setup();
  await controller.enable("a".repeat(64));
  await controller.renew("b".repeat(64));
  expect(deps.register).toHaveBeenCalledTimes(1);
});
