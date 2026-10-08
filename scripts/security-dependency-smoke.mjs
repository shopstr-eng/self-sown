// Exercise the real transitive dependencies, not mocks or unused store copies.
// Run: node --test scripts/security-dependency-smoke.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, get } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import zlib from "node:zlib";

const root = createRequire(new URL("../package.json", import.meta.url));
const mobile = createRequire(
  new URL("../apps/mobile/package.json", import.meta.url)
);
function consumer(require, ...packages) {
  for (const name of packages) require = createRequire(require.resolve(name));
  return require;
}
const cli = consumer(mobile, "expo", "@expo/cli");
const ellipticRequire = consumer(root, "bolt11", "secp256k1/elliptic");
const braces = consumer(
  root,
  "@ducanh2912/next-pwa",
  "fast-glob",
  "micromatch"
)("braces");
const sprintf = consumer(
  root,
  "babel-jest",
  "babel-plugin-istanbul",
  "@istanbuljs/load-nyc-config",
  "js-yaml",
  "argparse"
)("sprintf-js");

test("MCP OAuth refuses credentials bound to a different authorization server", async () => {
  const { auth } = root("@modelcontextprotocol/sdk/client/auth.js");
  let requests = 0;
  await assert.rejects(
    auth(
      {
        clientMetadata: {},
        discoveryState: () => ({
          authorizationServerUrl: "https://attacker.example/",
          authorizationServerMetadata: {
            issuer: "https://attacker.example/",
            authorization_endpoint: "https://attacker.example/authorize",
            token_endpoint: "https://attacker.example/token",
          },
          resourceMetadata: {
            resource: "https://mcp.example/",
            authorization_servers: ["https://attacker.example/"],
          },
        }),
        clientInformation: () => ({
          client_id: "test-client",
          client_secret: "test-secret",
          issuer: "https://trusted.example/",
        }),
        tokens: () => ({
          access_token: "test-access",
          refresh_token: "test-refresh",
          token_type: "Bearer",
          issuer: "https://trusted.example/",
        }),
      },
      {
        serverUrl: "https://mcp.example/",
        fetchFn: async () => {
          requests++;
          throw new Error("Credentials must never be sent");
        },
      }
    ),
    /bound to authorization server/
  );
  assert.equal(requests, 0);
});

test("shell-quote rejects command injection after comment tokens", () => {
  const shell = consumer(
    mobile,
    "react-native",
    "react-devtools-core"
  )("shell-quote");
  assert.equal(shell.quote(["echo", "hello world"]), "echo 'hello world'");
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    assert.throws(
      () => shell.quote(["echo", "ok", { comment: "x" }, `a${terminator}id;#`]),
      TypeError
    );
    assert.throws(
      () =>
        shell.quote(
          shell
            .parse("echo http://example.com/#frag")
            .concat(`a${terminator}id;#`)
        ),
      TypeError
    );
  }
});

test("sharp uses patched librsvg and still converts SVG images", async () => {
  const sharp = root("sharp");
  assert.equal(sharp.versions.sharp, "0.35.5");
  const [major, minor, patch] = sharp.versions.rsvg.split(".").map(Number);
  assert.ok(
    major > 2 || (major === 2 && (minor > 63 || (minor === 63 && patch >= 2))),
    `Unpatched librsvg: ${sharp.versions.rsvg}`
  );
  const { data, info } = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>'
    )
  )
    .png()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 8);
  assert.equal(info.height, 8);
  assert.equal(info.format, "png");
  assert.ok(data.length > 0);
});

test("proxy-addr rejects IPv4 clients outside mapped IPv6 trust subnets", () => {
  const express = consumer(
    root,
    "@modelcontextprotocol/sdk/server/streamableHttp.js",
    "express"
  );
  const proxyaddr = express("proxy-addr");
  assert.equal(express("proxy-addr/package.json").version, "2.0.8");
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    assert.equal(proxyaddr.compile(subnet)("203.0.113.1"), false);
  }
  const trust = proxyaddr.compile("::ffff:10.0.0.0/104");
  assert.equal(trust("10.1.2.3"), true);
  assert.equal(trust("203.0.113.1"), false);
});

test("source-map-js rejects malicious offsets but preserves ordinary maps", () => {
  const postcss = consumer(root, "next", "postcss");
  const { SourceMapConsumer, SourceMapGenerator } = postcss("source-map-js");
  assert.equal(postcss("source-map-js/package.json").version, "1.2.2");
  const map = { version: 3, sources: ["a.js"], names: [], mappings: "AAAA" };
  for (const line of [1e12, Infinity, -1, 0.5]) {
    assert.throws(
      () =>
        new SourceMapConsumer({
          version: 3,
          sections: [{ offset: { line, column: 0 }, map }],
        }),
      /offset/i
    );
  }
  const generator = new SourceMapGenerator();
  generator.addMapping({
    source: "a.js",
    original: { line: 1, column: 0 },
    generated: { line: 1, column: 0 },
  });
  assert.equal(
    new SourceMapConsumer(generator.toJSON()).originalPositionFor({
      line: 1,
      column: 0,
    }).source,
    "a.js"
  );
});

test("node-forge rejects nested DigestAlgorithm garbage in signed RSA blocks", () => {
  const forge = cli("node-forge");
  const { privateKey, publicKey } = forge.pki.rsa.generateKeyPair({
    bits: 1024,
    e: 3,
  });
  const digest = () => forge.md.sha256.create().update("regression");
  assert.equal(
    publicKey.verify(digest().digest().getBytes(), privateKey.sign(digest())),
    true
  );
  const { asn1 } = forge;
  const seq = (nodes) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, nodes);
  const oid = asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OID,
    false,
    asn1.oidToDer(forge.oids.sha256).getBytes()
  );
  const nil = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");
  const octet = (bytes) =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, bytes);
  for (const algorithm of [[oid], [oid, nil]]) {
    const valid = asn1
      .toDer(seq([seq(algorithm), octet(digest().digest().getBytes())]))
      .getBytes();
    assert.equal(
      publicKey.verify(
        digest().digest().getBytes(),
        privateKey.sign(valid, "NONE")
      ),
      true
    );
    const invalid = asn1
      .toDer(
        seq([
          seq([...algorithm, octet("garbage")]),
          octet(digest().digest().getBytes()),
        ])
      )
      .getBytes();
    assert.throws(
      () =>
        publicKey.verify(
          digest().digest().getBytes(),
          privateKey.sign(invalid, "NONE")
        ),
      /DigestInfo/
    );
  }
});

test("compression releases native gzip streams when clients abort", async () => {
  assert.equal(cli("compression/package.json").version, "1.8.2");
  const descriptor = Object.getOwnPropertyDescriptor(zlib, "createGzip");
  const streams = [];
  Object.defineProperty(zlib, "createGzip", {
    configurable: true,
    value: (...args) => {
      const stream = descriptor.value(...args);
      streams.push(stream);
      return stream;
    },
  });
  const compression = cli("compression")({ threshold: 0 });
  const server = createServer((req, res) => {
    compression(req, res, () => {
      res.setHeader("Content-Type", "text/plain");
      res.write("response ".repeat(1024));
      res.flush();
      // Deliberately never end: the client disconnects while gzip is active.
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve, reject) => {
        const request = get(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            headers: { "Accept-Encoding": "gzip" },
          },
          (res) => {
            assert.equal(res.headers["content-encoding"], "gzip");
            res.once("data", () => {
              res.destroy();
              resolve();
            });
            res.on("error", () => {});
          }
        );
        request.on("error", reject);
        request.setTimeout(3000, () =>
          request.destroy(new Error("compression test timed out"))
        );
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(streams.length, 3);
    assert.ok(
      streams.every((stream) => stream.destroyed && stream._handle === null)
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    Object.defineProperty(zlib, "createGzip", descriptor);
  }
});

test("braces bounds nesting in both patterns and caller-supplied ASTs", () => {
  assert.deepEqual(braces.expand("x/{a,b}/{1..2}"), [
    "x/a/1",
    "x/a/2",
    "x/b/1",
    "x/b/2",
  ]);
  assert.equal(braces.compile("x/{a,b}"), "x/(a|b)");
  assert.equal(braces.stringify(braces.parse("x/{a,b}")), "x/{a,b}");
  for (const pattern of [
    "{".repeat(4000) + "a,b" + "}".repeat(4000),
    "(".repeat(4000) + "a" + ")".repeat(4000),
    "{".repeat(4000),
  ]) {
    for (const method of ["parse", "compile", "expand", "stringify"]) {
      assert.throws(() => braces[method](pattern), {
        name: "SyntaxError",
        message: /nesting/,
      });
    }
  }
  for (const method of ["compile", "expand", "stringify"]) {
    let ast = { type: "text", value: "a" };
    for (let i = 0; i < 10000; i++) ast = { type: "root", nodes: [ast] };
    assert.throws(() => braces[method](ast), {
      name: "SyntaxError",
      message: /nesting/,
    });
  }
});

test("elliptic preserves RFC 6979 nonce width when leading bytes are zero", () => {
  const { ec: EC } = ellipticRequire("elliptic");
  const HmacDRBG = ellipticRequire("hmac-drbg");
  const BN = ellipticRequire("bn.js");
  const ec = new EC("p521");
  const original = HmacDRBG.prototype.generate;
  // 66 octets for P-521; the leading zero must still count in bits2int.
  const bytes = new Array(66).fill(0x42);
  bytes[0] = 0;
  bytes[1] = 0x80;
  const expectedK = new BN(bytes).ushrn(7);
  const expected = ec.sign("abcd", "01", { k: () => expectedK });
  try {
    HmacDRBG.prototype.generate = () => bytes;
    const actual = ec.sign("abcd", "01");
    assert.equal(actual.r.toString(16), expected.r.toString(16));
    assert.equal(actual.s.toString(16), expected.s.toString(16));
    assert.equal(ec.verify("abcd", actual, ec.keyFromPrivate("01")), true);
  } finally {
    HmacDRBG.prototype.generate = original;
  }
  const bolt11 = root("bolt11");
  const invoice = bolt11.sign(
    bolt11.encode({
      satoshis: 25,
      timestamp: 1700000000,
      tags: [
        { tagName: "payment_hash", data: "11".repeat(32) },
        { tagName: "description", data: "security regression" },
      ],
    }),
    "01".repeat(32)
  );
  assert.equal(bolt11.decode(invoice.paymentRequest).satoshis, 25);
});

test("sprintf-js bounds hostile precision without changing ordinary formatting", () => {
  assert.equal(sprintf.sprintf("%.2f", 1.234), "1.23");
  assert.equal(sprintf.vsprintf("%s: %d", ["count", 2]), "count: 2");
  for (const type of ["e", "f", "g"]) {
    for (const precision of ["0", "101", "999999999999999999999999999999999"]) {
      const output = sprintf.sprintf(`%.${precision}${type}`, 1.234);
      assert.equal(typeof output, "string");
      assert.ok(output.length < 120);
    }
  }
});
