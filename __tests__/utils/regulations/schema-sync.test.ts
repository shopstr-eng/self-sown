import { readFileSync } from "fs";
import { resolve } from "path";
import { REGULATIONS_SCHEMA } from "@/utils/db/regulations-schema";

// Same contract as the mobile-notification schema: runtime bootstrap and
// self-host standalone installs must apply identical DDL.
test("runtime and standalone installations use the same regulations schema", () => {
  const standalone = readFileSync(
    resolve(__dirname, "../../../db/schema.sql"),
    "utf8"
  );
  expect(standalone).toContain(REGULATIONS_SCHEMA.trim());
});
