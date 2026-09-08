/** @jest-environment node */
import type { NextApiRequest, NextApiResponse } from "next";
import { createNotificationProcessorHandler } from "../../../../utils/notifications/processor-handler";
const secret = "s".repeat(32);
function setup(enabled = true) {
  const process = jest.fn(async () => ({ accepted: 0 }));
  const handler = createNotificationProcessorHandler({
    secret: () => secret,
    enabled: () => enabled,
    process,
  });
  const res = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return {
    process,
    res,
    run: (authorization?: string, method = "POST") =>
      handler(
        { method, headers: { authorization } } as NextApiRequest,
        res as unknown as NextApiResponse
      ),
  };
}
test("rejects unauthenticated and wrong-method processor requests", async () => {
  const t = setup();
  await t.run();
  expect(t.res.status).toHaveBeenLastCalledWith(401);
  await t.run(`Bearer ${secret}`, "GET");
  expect(t.res.status).toHaveBeenLastCalledWith(405);
  expect(t.process).not.toHaveBeenCalled();
});
test("disabled processing never initializes provider or database", async () => {
  const t = setup(false);
  await t.run(`Bearer ${secret}`);
  expect(t.res.json).toHaveBeenCalledWith({ enabled: false });
  expect(t.process).not.toHaveBeenCalled();
});
test("authorized processing returns only counters", async () => {
  const t = setup();
  await t.run(`Bearer ${secret}`);
  expect(t.res.json).toHaveBeenCalledWith({
    enabled: true,
    result: { accepted: 0 },
  });
});
