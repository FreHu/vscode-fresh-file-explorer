import * as assert from "assert";

import { extractTicketIds, buildWorkUnits, computeCrossRepoPresence, TicketCommit } from "../../cochange/workUnits";

/** Synthetic commit subjects and paths only — no real repository data. */
suite("cross-repo work units", () => {
  suite("extractTicketIds", () => {
    test("finds JIRA-style keys", () => {
      assert.deepStrictEqual(extractTicketIds("AB-123 - add the widget"), ["ab-123"]);
    });

    test("finds ClickUp-style ids, bare and in URLs", () => {
      assert.deepStrictEqual(extractTicketIds("861abcdef - fix panel"), ["861abcdef"]);
      assert.deepStrictEqual(
        extractTicketIds("fix panel https://app.clickup.com/t/1234/862zzzyyy"),
        ["862zzzyyy"],
      );
    });

    test("does not join on #issue numbers (per-repo, would join unrelated work)", () => {
      assert.deepStrictEqual(extractTicketIds("fix crash, closes #123"), []);
    });

    test("finds Azure Boards and Shortcut references", () => {
      assert.deepStrictEqual(extractTicketIds("AB#456 wire up the export"), ["ab#456"]);
      assert.deepStrictEqual(extractTicketIds("sc-789: polish the modal"), ["sc-789"]);
    });

    test("technical tokens that look like JIRA keys are not join keys", () => {
      assert.deepStrictEqual(extractTicketIds("support UTF-8 filenames"), []);
      assert.deepStrictEqual(extractTicketIds("switch checksums to SHA-256"), []);
      assert.deepStrictEqual(extractTicketIds("parse ISO-8601 dates per RFC-3339"), []);
      // CVE ids stay joinable — patching the same CVE in two repos is one unit of work.
      assert.deepStrictEqual(extractTicketIds("mitigate CVE-2026-12345"), ["cve-2026-12345"]);
    });

    test("dedupes and lowercases; supports a custom pattern", () => {
      assert.deepStrictEqual(extractTicketIds("AB-1 ab-1 done"), ["ab-1"]);
      assert.deepStrictEqual(extractTicketIds("task TK_99 done", /\bTK_\d+\b/g), ["tk_99"]);
    });
  });

  const c = (repo: string, message: string, files: string[], at?: number): TicketCommit =>
    ({ repo, message, files, at });

  suite("buildWorkUnits", () => {
    test("groups commits across repos by ticket and keeps the latest timestamp", () => {
      const units = buildWorkUnits([
        c("api", "AB-1 backend part", ["svc/a.ts"], 100),
        c("web", "AB-1 frontend part", ["pages/a.ts"], 200),
        c("api", "AB-2 unrelated", ["svc/b.ts"], 150),
        c("api", "no ticket here", ["svc/c.ts"]),
      ]);

      assert.deepStrictEqual(units.map(u => u.ticket).sort(), ["ab-1", "ab-2"]);
      const ab1 = units.find(u => u.ticket === "ab-1")!;
      assert.deepStrictEqual([...ab1.filesByRepo.keys()].sort(), ["api", "web"]);
      assert.strictEqual(ab1.at, 200);
    });
  });

  suite("computeCrossRepoPresence", () => {
    /** n units per template: ticket unique, api files fixed, web presence optional. */
    const units = (specs: { n: number; apiFiles: string[]; web?: boolean; at?: number }[]) => {
      const commits: TicketCommit[] = [];
      let ticket = 0;
      for (const spec of specs) {
        for (let i = 0; i < spec.n; i++) {
          const id = `AB-${++ticket}`;
          commits.push(c("api", `${id} api work`, spec.apiFiles, spec.at));
          if (spec.web) {
            commits.push(c("web", `${id} web work`, ["pages/p.ts"], spec.at));
          }
        }
      }
      return buildWorkUnits(commits);
    };

    test("nudges when an area implies the other repo well above the base rate", () => {
      const built = units([
        { n: 8, apiFiles: ["model/entity.ts"], web: true },   // model → web, strong
        { n: 2, apiFiles: ["model/entity.ts"] },               // model without web
        { n: 20, apiFiles: ["infra/deploy.ts"] },              // api-only background → low base rate
      ]);
      const result = computeCrossRepoPresence(built, { repo: "api", files: ["model/entity.ts"] });

      assert.strictEqual(result.length, 1);
      const n = result[0];
      assert.strictEqual(n.targetRepo, "web");
      assert.strictEqual(n.together, 8);
      assert.strictEqual(n.total, 10);
      assert.ok(Math.abs(n.baseRate - 8 / 30) < 1e-9);
      assert.strictEqual(n.sourceKind, "file");
    });

    test("stays silent when the other repo is implied at the base rate anyway", () => {
      // Every ticket spans both repos — 'model implies web' is just how tickets work here.
      const built = units([
        { n: 10, apiFiles: ["model/entity.ts"], web: true },
        { n: 20, apiFiles: ["infra/deploy.ts"], web: true },
      ]);
      const result = computeCrossRepoPresence(built, { repo: "api", files: ["model/entity.ts"] });
      assert.deepStrictEqual(result, [], "confidence 1.0 vs base rate 1.0 has no lift");
    });

    test("below support or confidence stays silent", () => {
      const thin = units([{ n: 2, apiFiles: ["model/entity.ts"], web: true }, { n: 20, apiFiles: ["x/y.ts"] }]);
      assert.deepStrictEqual(computeCrossRepoPresence(thin, { repo: "api", files: ["model/entity.ts"] }), []);

      const weak = units([
        { n: 3, apiFiles: ["model/entity.ts"], web: true },
        { n: 4, apiFiles: ["model/entity.ts"] },
        { n: 20, apiFiles: ["x/y.ts"] },
      ]);
      assert.deepStrictEqual(
        computeCrossRepoPresence(weak, { repo: "api", files: ["model/entity.ts"] }),
        [], "3/7 is under the confidence floor",
      );
    });

    test("liveness: a coupling whose shared tickets stopped is filtered", () => {
      const built = units([
        { n: 6, apiFiles: ["model/entity.ts"], web: true, at: 100 },
        { n: 20, apiFiles: ["x/y.ts"], at: 300 },
      ]);
      const result = computeCrossRepoPresence(built, { repo: "api", files: ["model/entity.ts"] }, { minLastTogetherAt: 200 });
      assert.deepStrictEqual(result, []);
    });

    test("pools through the parent dir when the exact file never appeared", () => {
      const commits: TicketCommit[] = [];
      for (let i = 0; i < 6; i++) {
        commits.push(c("api", `AB-${i} api`, [`model/m${i}.ts`]));
        commits.push(c("web", `AB-${i} web`, ["pages/p.ts"]));
      }
      for (let i = 100; i < 120; i++) {
        commits.push(c("api", `AB-${i} api only`, ["infra/z.ts"]));
      }
      const result = computeCrossRepoPresence(buildWorkUnits(commits), { repo: "api", files: ["model/brandNew.ts"] });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].source, "model");
      assert.strictEqual(result[0].sourceKind, "dir");
      assert.strictEqual(result[0].together, 6);
    });

    test("at most one nudge per target repo — the strongest conditioning item wins", () => {
      const built = units([
        { n: 10, apiFiles: ["model/entity.ts", "svc/handler.ts"], web: true },
        { n: 5, apiFiles: ["svc/handler.ts"] },
        { n: 20, apiFiles: ["x/y.ts"] },
      ]);
      const result = computeCrossRepoPresence(built, { repo: "api", files: ["model/entity.ts", "svc/handler.ts"] });

      assert.strictEqual(result.length, 1);
      // entity: 10/10; handler: 10/15 — entity is the stronger statement.
      assert.strictEqual(result[0].source, "model/entity.ts");
      assert.strictEqual(result[0].confidence, 1);
    });
  });
});
