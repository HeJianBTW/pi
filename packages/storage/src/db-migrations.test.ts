import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./db-migrations.js";

describe("splitSqlStatements", () => {
  it("splits SQL statements while ignoring comments and quoted semicolons", () => {
    expect(splitSqlStatements(`
      -- comment with ;
      CREATE TABLE \`example\` (
        id VARCHAR(64) NOT NULL,
        text_value TEXT NULL
      );
      INSERT INTO \`example\` (id, text_value) VALUES ('one', 'hello; world');
      /* block ; comment */
      CREATE INDEX \`idx_example_text\` ON \`example\` (id);
    `)).toEqual([
      "CREATE TABLE `example` (\n        id VARCHAR(64) NOT NULL,\n        text_value TEXT NULL\n      )",
      "INSERT INTO `example` (id, text_value) VALUES ('one', 'hello; world')",
      "CREATE INDEX `idx_example_text` ON `example` (id)",
    ]);
  });
});
