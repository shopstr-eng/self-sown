const mockReadFileSync = jest.fn();

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  };
});

import type { NextApiRequest, NextApiResponse } from "next";

type MockRes = {
  setHeader: jest.Mock;
  status: jest.Mock;
  json: jest.Mock;
  body: unknown;
};

const mockRes = (): MockRes => {
  const res: MockRes = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
    body: undefined,
  };
  res.status.mockReturnValue(res);
  res.json.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
};

// The handler caches the build ID in module state, so each test gets a fresh
// module registry to exercise first-read behavior independently.
const loadHandler = async () => {
  jest.resetModules();
  return (await import("@/pages/api/version")).default;
};

describe("/api/version", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  it("serves the build ID from .next/BUILD_ID, trimmed, with no-store", async () => {
    mockReadFileSync.mockReturnValue("  abc123def456\n");
    const handler = await loadHandler();
    const res = mockRes();

    handler({} as NextApiRequest, res as unknown as NextApiResponse);

    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.next[/\\]BUILD_ID$/),
      "utf8"
    );
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ buildId: "abc123def456" });
  });

  it("reads BUILD_ID once and caches it for the process lifetime", async () => {
    mockReadFileSync.mockReturnValue("cached-build");
    const handler = await loadHandler();

    const first = mockRes();
    handler({} as NextApiRequest, first as unknown as NextApiResponse);

    // A rebuild swaps BUILD_ID on disk — the running process must keep
    // reporting the build it is actually serving.
    mockReadFileSync.mockReturnValue("different-build");
    const second = mockRes();
    handler({} as NextApiRequest, second as unknown as NextApiResponse);

    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(second.body).toEqual({ buildId: "cached-build" });
  });

  it('falls back to "dev" when BUILD_ID is unreadable, and caches that too', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const handler = await loadHandler();

    const first = mockRes();
    handler({} as NextApiRequest, first as unknown as NextApiResponse);
    expect(first.status).toHaveBeenCalledWith(200);
    expect(first.body).toEqual({ buildId: "dev" });

    const second = mockRes();
    handler({} as NextApiRequest, second as unknown as NextApiResponse);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(second.body).toEqual({ buildId: "dev" });
  });
});
