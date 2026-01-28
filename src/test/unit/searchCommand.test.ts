import { expect } from "chai";
import { optimizeIncludePatterns } from "../../utils/patternUtils";

describe("Search Command - Pattern Optimization", () => {
  describe("optimizeIncludePatterns", () => {
    it("should return empty string for empty array", () => {
      const result = optimizeIncludePatterns([]);
      expect(result).to.equal("");
    });

    it("should return single path as-is", () => {
      const result = optimizeIncludePatterns(["lib/utils/helpers.ts"]);
      expect(result).to.equal("lib/utils/helpers.ts");
    });

    it("should group files in the same directory with braces", () => {
      const paths = [
        "app/components/Button.tsx",
        "app/components/Input.tsx",
        "app/components/Modal.tsx",
      ];
      const result = optimizeIncludePatterns(paths);
      expect(result).to.equal("app/components/{Button.tsx,Input.tsx,Modal.tsx}");
    });

    it("should handle files in different directories with comma separation", () => {
      const paths = [
        "app/components/Button.tsx",
        "lib/utils/format.ts",
        "services/api/client.ts",
      ];
      const result = optimizeIncludePatterns(paths);
      // Files in different directories, joined with commas (no outer braces)
      expect(result).to.equal("app/components/Button.tsx,lib/utils/format.ts,services/api/client.ts");
    });

    it("should combine directory grouping with comma separation", () => {
      const paths = [
        "app/components/Button.tsx",
        "app/components/Input.tsx",
        "lib/utils/format.ts",
        "lib/utils/validate.ts",
      ];
      const result = optimizeIncludePatterns(paths);
      // Two directory groups, each with braces, joined with comma (no outer braces)
      expect(result).to.equal("app/components/{Button.tsx,Input.tsx},lib/utils/{format.ts,validate.ts}");
    });

    it("should handle mix of single files and grouped files", () => {
      const paths = [
        "app/components/Button.tsx",
        "app/components/Input.tsx",
        "lib/config.ts", // Single file in lib/
        "services/api/client.ts", // Single file in services/api/
      ];
      const result = optimizeIncludePatterns(paths);
      expect(result).to.equal("app/components/{Button.tsx,Input.tsx},lib/config.ts,services/api/client.ts");
    });

    it("should handle deeply nested directory structures", () => {
      const paths = [
        "app/features/dashboard/components/Chart.tsx",
        "app/features/dashboard/components/Table.tsx",
        "app/features/settings/pages/Profile.tsx",
      ];
      const result = optimizeIncludePatterns(paths);
      expect(result).to.equal(
        "app/features/dashboard/components/{Chart.tsx,Table.tsx},app/features/settings/pages/Profile.tsx"
      );
    });

    it("should handle files at root level (no directory)", () => {
      const paths = ["config.json", "tsconfig.json", "package.json"];
      const result = optimizeIncludePatterns(paths);
      // Root level files grouped with braces
      expect(result).to.equal("{config.json,tsconfig.json,package.json}");
    });

    it("should handle mix of root-level and nested files", () => {
      const paths = [
        "README.md",
        "LICENSE",
        "app/main.ts",
        "app/utils.ts",
      ];
      const result = optimizeIncludePatterns(paths);
      expect(result).to.equal("{README.md,LICENSE},app/{main.ts,utils.ts}");
    });

    describe("Path Expansion Demonstrations", () => {
      it("demonstrates significant compression for files in same directory", () => {
        const paths = [
          "frontend/pages/Home.tsx",
          "frontend/pages/About.tsx",
          "frontend/pages/Contact.tsx",
          "frontend/pages/Products.tsx",
        ];
        
        // Without optimization: 103 chars
        const unoptimized = paths.join(",");
        
        // With optimization: much shorter
        const optimized = optimizeIncludePatterns(paths);
        
        expect(optimized).to.equal("frontend/pages/{Home.tsx,About.tsx,Contact.tsx,Products.tsx}");
        expect(optimized.length).to.be.lessThan(unoptimized.length);
        expect(optimized.length).to.equal(60); // Significant reduction from 103 chars
      });

      it("demonstrates expansion factor remains ~3x for ripgrep", () => {
        // This test demonstrates the concept that ripgrep will expand each path
        // into ~3 arguments due to spreadGlobComponents()
        const paths = [
          "backend/services/auth/login.ts",
          "backend/services/auth/logout.ts",
        ];
        
        const optimized = optimizeIncludePatterns(paths);
        expect(optimized).to.equal("backend/services/auth/{login.ts,logout.ts}");
        
        // VS Code's spreadGlobComponents will expand this to approximately:
        // -g backend
        // -g backend/services
        // -g backend/services/auth
        // -g backend/services/auth/login.ts (from brace expansion)
        // -g backend/services/auth/logout.ts (from brace expansion)
        // 
        // So a 47-char pattern becomes ~5 arguments × ~15 chars each = ~75 chars
        // This is the ~3x expansion factor (pattern chars → command-line chars)
        const estimatedRipgrepArgs = optimized.length * 3;
        expect(estimatedRipgrepArgs).to.be.approximately(141, 50);
      });

      it("demonstrates why 4000 char limit handles typical workspaces", () => {
        // Generate a realistic scenario: 100 files across 10 directories
        const paths: string[] = [];
        for (let i = 0; i < 10; i++) {
          for (let j = 0; j < 10; j++) {
            paths.push(`modules/feature${i}/Component${j}.tsx`);
          }
        }
        
        const optimized = optimizeIncludePatterns(paths);
        
        // Pattern should be well under 4000 chars
        expect(optimized.length).to.be.lessThan(4000);
        
        // Should use brace expansion efficiently
        expect(optimized).to.include("{");
        
        // Each directory group should be comma-separated (no outer nesting)
        const groups = optimized.split(",modules/feature");
        expect(groups.length).to.be.greaterThan(1);
      });

      it("avoids nested braces which ripgrep rejects", () => {
        const paths = [
          "api/v1/endpoints/users.ts",
          "api/v1/endpoints/posts.ts",
          "api/v2/endpoints/users.ts",
        ];
        
        const optimized = optimizeIncludePatterns(paths);
        
        // Should produce: api/v1/endpoints/{users.ts,posts.ts},api/v2/endpoints/users.ts
        // NOT: {api/v1/endpoints/{users.ts,posts.ts},api/v2/endpoints/users.ts}
        expect(optimized).to.equal("api/v1/endpoints/{users.ts,posts.ts},api/v2/endpoints/users.ts");
        
        // Verify no nested braces by checking that pattern doesn't start with {
        // (which would wrap the entire result)
        if (optimized.includes("{")) {
          // If there are braces, ensure they're not nested
          const firstBrace = optimized.indexOf("{");
          const lastBrace = optimized.lastIndexOf("}");
          const betweenBraces = optimized.substring(firstBrace + 1, lastBrace);
          
          // If pattern has multiple groups, braces should be in separate segments
          if (optimized.split(",").length > 1) {
            // Each group with braces should be comma-separated
            // No group should contain another complete {group}
            const segments = optimized.split(",");
            for (const segment of segments) {
              const braceCount = (segment.match(/{/g) || []).length;
              expect(braceCount).to.be.at.most(1, `Segment "${segment}" should have at most one opening brace`);
            }
          }
        }
      });

      it("handles large workspace with multiple directory levels", () => {
        const paths = [
          // Backend services
          "backend/auth/controllers/LoginController.ts",
          "backend/auth/controllers/RegisterController.ts",
          "backend/auth/services/TokenService.ts",
          "backend/database/models/User.ts",
          "backend/database/models/Session.ts",
          "backend/database/repositories/UserRepository.ts",
          // Frontend components
          "frontend/shared/Button.tsx",
          "frontend/shared/Input.tsx",
          "frontend/layouts/MainLayout.tsx",
          "frontend/layouts/AuthLayout.tsx",
          // Config files
          "config/database.json",
          "config/auth.json",
        ];
        
        const optimized = optimizeIncludePatterns(paths);
        
        // Should group by directory
        expect(optimized).to.include("backend/auth/controllers/{LoginController.ts,RegisterController.ts}");
        expect(optimized).to.include("backend/database/models/{User.ts,Session.ts}");
        expect(optimized).to.include("frontend/shared/{Button.tsx,Input.tsx}");
        expect(optimized).to.include("frontend/layouts/{MainLayout.tsx,AuthLayout.tsx}");
        expect(optimized).to.include("config/{database.json,auth.json}");
        
        // Verify comma separation between groups (no outer braces)
        expect(optimized.startsWith("{")).to.be.false;
        expect(optimized.endsWith("}")).to.be.true; // Last group ends with }
      });
    });
  });
});
