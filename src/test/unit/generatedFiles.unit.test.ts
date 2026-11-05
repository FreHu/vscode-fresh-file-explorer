import * as assert from "assert";
import { suite, test } from "mocha";
import { parseGeneratedAttributes } from "../../git/generatedFiles";

const triple = (path: string, attr: string, value: string) => `${path}\0${attr}\0${value}\0`;

suite("generated files — git check-attr -z", () => {
  test("set and =true mark a file generated", () => {
    const out = triple("package-lock.json", "linguist-generated", "set")
      + triple("api/client.ts", "linguist-generated", "true");
    assert.deepStrictEqual([...parseGeneratedAttributes(out)], ["package-lock.json", "api/client.ts"]);
  });

  test("unset, =false and unspecified don't", () => {
    const out = triple("a.ts", "linguist-generated", "unset")
      + triple("b.ts", "linguist-generated", "false")
      + triple("c.ts", "linguist-generated", "unspecified");
    assert.deepStrictEqual([...parseGeneratedAttributes(out)], []);
  });

  test("either attribute is enough", () => {
    const out = triple("schema.ts", "linguist-generated", "unspecified")
      + triple("schema.ts", "gitlab-generated", "set");
    assert.deepStrictEqual([...parseGeneratedAttributes(out)], ["schema.ts"]);
  });

  test("paths with spaces and non-ASCII survive", () => {
    const out = triple("docs/Übersicht neu.md", "linguist-generated", "set");
    assert.deepStrictEqual([...parseGeneratedAttributes(out)], ["docs/Übersicht neu.md"]);
  });

  test("empty output", () => {
    assert.deepStrictEqual([...parseGeneratedAttributes("")], []);
  });
});
