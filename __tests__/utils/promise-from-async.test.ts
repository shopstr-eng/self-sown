import { promiseFromAsync } from "@/utils/promise-from-async";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("promiseFromAsync", () => {
  it("resolves when the body settles via resolve()", async () => {
    await expect(
      promiseFromAsync(async (resolve) => {
        await flush();
        resolve("done");
      })
    ).resolves.toBe("done");
  });

  it("rejects with an error thrown after the first await", async () => {
    const boom = new Error("background fetch crashed");
    await expect(
      promiseFromAsync(async () => {
        await flush();
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  it("rejects with an error thrown before any await", async () => {
    const boom = new Error("sync crash");
    await expect(
      promiseFromAsync(async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });

  it("does not produce an unhandled rejection when the body throws after already resolving", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const promise = promiseFromAsync(async (resolve) => {
        resolve("settled");
        await flush();
        throw new Error("late crash after settle");
      });
      await expect(promise).resolves.toBe("settled");
      // Give the event loop room to report any escaped rejection.
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("lets the body reject explicitly", async () => {
    const boom = new Error("explicit rejection");
    await expect(
      promiseFromAsync(async (_resolve, reject) => {
        await flush();
        reject(boom);
      })
    ).rejects.toBe(boom);
  });
});
