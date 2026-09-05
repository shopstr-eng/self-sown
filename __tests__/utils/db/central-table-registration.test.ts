/**
 * Guard: every table created lazily in its own module must ALSO be created by
 * the central initializeTables() in utils/db/db-service.ts.
 *
 * Why: a quiet dev database only gets tables from initializeTables(). A table
 * that exists in prod (created by real traffic through a lazy ensure*) but not
 * in dev is read by the publish schema-diff as "removed", gets paired with an
 * unrelated new-table "add", and forces a rename-or-drop choice — both answers
 * corrupt or destroy data. This test fails before that can happen.
 *
 * Pure fs/regex scan: no app imports (db-service.ts transitively pulls
 * nostr-tools, which jest's transformer can't parse) and no database.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = process.cwd();
const CENTRAL_INIT = path.join(REPO_ROOT, "utils", "db", "db-service.ts");
const SCAN_DIRS = ["utils", "pages", "lib", "mcp", "emails", "components"];
const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-z_][a-z0-9_]*)["']?/gi;
// A CREATE TABLE whose name is interpolated (e.g. `CREATE TABLE ${name}`)
// can't be verified statically — flag it so the registration is done by hand.
const DYNAMIC_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?\$\{/gi;

function collectSourceFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(
        ...collectSourceFiles(path.relative(REPO_ROOT, full))
      );
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function tablesCreatedIn(source: string): string[] {
  // The optional IF NOT EXISTS group can backtrack when a comment mentions
  // the phrase without a table name after it; "if" is never a real capture.
  // Names are lowercased so comparison is case-insensitive like Postgres.
  const names: string[] = [];
  for (const m of source.matchAll(CREATE_TABLE_RE)) {
    const name = m[1];
    if (name && name.toLowerCase() !== "if") names.push(name.toLowerCase());
  }
  return names;
}

function hasDynamicTableName(source: string): boolean {
  return DYNAMIC_TABLE_RE.test(source);
}

describe("central table registration", () => {
  it("every lazily-created table is also created by initializeTables' module", () => {
    const centralTables = new Set(
      tablesCreatedIn(fs.readFileSync(CENTRAL_INIT, "utf8"))
    );
    expect(centralTables.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectSourceFiles(dir)) {
        if (file === CENTRAL_INIT) continue;
        const source = fs.readFileSync(file, "utf8");
        if (hasDynamicTableName(source)) {
          offenders.push(
            `<dynamic table name> (${path.relative(REPO_ROOT, file)}) — verify registration by hand`
          );
        }
        for (const table of tablesCreatedIn(source)) {
          if (!centralTables.has(table)) {
            offenders.push(
              `${table} (${path.relative(REPO_ROOT, file)})`
            );
          }
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Tables created outside utils/db/db-service.ts must also be registered in its initializeTables(), or a quiet dev DB won't have them and the publish schema-diff will force a destructive rename/drop. Offenders:\n${offenders.join("\n")}`
      );
    }
    expect(offenders).toEqual([]);
  });
});
