const lookupMock = jest.fn();

jest.mock("dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  isPrivateIPv4,
  isPrivateIPv6,
  isSafePublicHostname,
  parseHttpUrl,
} from "@/utils/url-safety";

describe("url-safety SSRF guards", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  describe("isPrivateIPv4", () => {
    it("flags loopback, private, link-local, CGNAT and benchmark ranges", () => {
      for (const ip of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.1.1",
        "100.64.0.1",
        "0.0.0.0",
        "198.18.0.1",
        "198.19.255.255",
        "224.0.0.1",
      ]) {
        expect(isPrivateIPv4(ip)).toBe(true);
      }
    });

    it("allows normal public addresses", () => {
      expect(isPrivateIPv4("93.184.216.34")).toBe(false);
      expect(isPrivateIPv4("8.8.8.8")).toBe(false);
      expect(isPrivateIPv4("198.17.255.255")).toBe(false);
    });

    it("fails closed on malformed input", () => {
      expect(isPrivateIPv4("not-an-ip")).toBe(true);
      expect(isPrivateIPv4("999.1.1.1")).toBe(true);
    });
  });

  describe("isPrivateIPv6", () => {
    it("flags loopback, unspecified, link-local and unique-local", () => {
      for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
        expect(isPrivateIPv6(ip)).toBe(true);
      }
    });

    it("blocks IPv4-mapped addresses that tunnel to internal IPv4 (dotted + hex)", () => {
      expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateIPv6("::ffff:7f00:1")).toBe(true); // == 127.0.0.1
      expect(isPrivateIPv6("::ffff:c0a8:1")).toBe(true); // == 192.168.0.1
      expect(isPrivateIPv6("::127.0.0.1")).toBe(true); // IPv4-compatible
    });

    it("strips zone ids before matching", () => {
      expect(isPrivateIPv6("fe80::1%eth0")).toBe(true);
    });

    it("allows a genuine public IPv6", () => {
      expect(isPrivateIPv6("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    });

    it("allows an IPv4-mapped public address", () => {
      expect(isPrivateIPv6("::ffff:93.184.216.34")).toBe(false);
    });
  });

  describe("isSafePublicHostname", () => {
    it("rejects localhost-style names without a DNS lookup", async () => {
      expect(await isSafePublicHostname("localhost")).toBe(false);
      expect(await isSafePublicHostname("db.local")).toBe(false);
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it("rejects a hostname whose DNS record resolves to a mapped internal IP", async () => {
      lookupMock.mockResolvedValue([
        { family: 6, address: "::ffff:127.0.0.1" },
      ]);
      expect(await isSafePublicHostname("evil.example")).toBe(false);
    });

    it("accepts a hostname that resolves to a public address", async () => {
      lookupMock.mockResolvedValue([{ family: 4, address: "93.184.216.34" }]);
      expect(await isSafePublicHostname("example.com")).toBe(true);
    });

    it("fails closed when DNS returns nothing", async () => {
      lookupMock.mockResolvedValue([]);
      expect(await isSafePublicHostname("nowhere.example")).toBe(false);
    });
  });

  describe("parseHttpUrl", () => {
    it("accepts http/https and rejects other schemes", () => {
      expect(parseHttpUrl("https://shop.example/path")?.protocol).toBe(
        "https:"
      );
      expect(parseHttpUrl("http://shop.example")?.protocol).toBe("http:");
      expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
      expect(parseHttpUrl("ftp://shop.example")).toBeNull();
      expect(parseHttpUrl("not a url")).toBeNull();
    });
  });
});
