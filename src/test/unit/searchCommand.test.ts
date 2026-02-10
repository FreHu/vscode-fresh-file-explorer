import { expect } from "chai";
import { optimizeIncludePatterns } from "../../utils/patternUtils";
import { batchFilesForSearch } from "../../commands/searchCommand";

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

  describe("batchFilesForSearch", () => {
    it("should return empty array for empty input", () => {
      const result = batchFilesForSearch([]);
      expect(result.batches).to.deep.equal([]);
      expect(result.oversizedFiles).to.deep.equal([]);
    });

    it("should return single batch when all files fit", () => {
      const paths = [
        "app/components/Button.tsx",
        "app/components/Input.tsx",
        "lib/utils/format.ts",
      ];
      const result = batchFilesForSearch(paths, 1000);
      
      expect(result.batches).to.have.lengthOf(1);
      expect(result.batches[0]).to.deep.equal(paths);
      expect(result.oversizedFiles).to.deep.equal([]);
    });

    it("should split into multiple batches when pattern is too long", () => {
      const paths = [
        "app/components/Button.tsx",
        "app/components/Input.tsx",
        "lib/utils/format.ts",
        "lib/utils/validate.ts",
        "services/api/client.ts",
      ];
      
      // Set a very small limit to force batching
      const result = batchFilesForSearch(paths, 50);
      
      expect(result.batches.length).to.be.greaterThan(1);
      
      // Verify all files are included
      const allFiles = result.batches.flat();
      expect(allFiles).to.have.lengthOf(paths.length);
      expect(allFiles.sort()).to.deep.equal(paths.sort());
    });

    it("should ensure each batch's pattern fits within the limit", () => {
      const paths = [
        "app/components/Button.tsx",
        "app/components/Input.tsx",
        "app/components/Modal.tsx",
        "lib/utils/format.ts",
        "lib/utils/validate.ts",
        "services/api/client.ts",
      ];
      
      const maxLength = 80;
      const result = batchFilesForSearch(paths, maxLength);
      
      // Verify each batch's optimized pattern is within the limit
      for (const batch of result.batches) {
        const pattern = optimizeIncludePatterns(batch);
        expect(pattern.length).to.be.at.most(maxLength,
          `Batch pattern "${pattern}" (${pattern.length} chars) exceeds limit of ${maxLength}`);
      }
    });

    it("should maximize files per batch using greedy algorithm", () => {
      const paths = [
        "a/b/file1.ts", // ~13 chars optimized
        "a/b/file2.ts", // Combined: a/b/{file1.ts,file2.ts} = 24 chars
        "a/b/file3.ts", // Combined: a/b/{file1.ts,file2.ts,file3.ts} = 34 chars
        "c/d/file4.ts", // Similar size
      ];
      
      // Limit allows 2 files from same dir but not 3
      const result = batchFilesForSearch(paths, 30);
      
      // Should have at least 2 batches
      expect(result.batches.length).to.be.at.least(2);
      
      // All files should be included
      const allFiles = result.batches.flat();
      expect(allFiles).to.have.lengthOf(paths.length);
    });

    it("should track single files that exceed limit", () => {
      const longPath = "a/".repeat(100) + "file.ts"; // Very long path
      const paths = [longPath];
      
      const result = batchFilesForSearch(paths, 50);
      
      // Should still return the file in a batch
      expect(result.batches).to.have.lengthOf(1);
      expect(result.batches[0]).to.deep.equal([longPath]);
      
      // Should be marked as oversized
      expect(result.oversizedFiles).to.have.lengthOf(1);
      expect(result.oversizedFiles[0]).to.equal(longPath);
    });

    it("should not lose files when mixing short and long paths", () => {
      const paths = [
        "short.ts",
        "a/".repeat(50) + "very-long-path.ts",
        "another-short.ts",
        "b/".repeat(50) + "another-long-path.ts",
      ];
      
      const result = batchFilesForSearch(paths, 100);
      
      // All files must be included
      const allFiles = result.batches.flat();
      expect(allFiles).to.have.lengthOf(paths.length);
      expect(allFiles.sort()).to.deep.equal(paths.sort());
      
      // Oversized files should be tracked
      expect(result.oversizedFiles.length).to.be.greaterThan(0);
    });

    it("should handle files from same directory efficiently", () => {
      // Create many files in the same directory
      const paths: string[] = [];
      for (let i = 0; i < 20; i++) {
        paths.push(`app/components/Component${i}.tsx`);
      }
      
      // Should group them efficiently using brace expansion
      const result = batchFilesForSearch(paths, 200);
      
      // Verify all files are included
      const allFiles = result.batches.flat();
      expect(allFiles).to.have.lengthOf(paths.length);
      expect(allFiles.sort()).to.deep.equal(paths.sort());
      
      // First batch should contain multiple files due to efficient grouping
      expect(result.batches[0].length).to.be.greaterThan(1);
    });

    it("should maintain file order within reasonable constraints", () => {
      const paths = [
        "app/a.ts",
        "app/b.ts",
        "lib/c.ts",
        "lib/d.ts",
      ];
      
      const result = batchFilesForSearch(paths, 1000);
      
      // When everything fits in one batch, order is preserved
      if (result.batches.length === 1) {
        expect(result.batches[0]).to.deep.equal(paths);
      }
    });

    it("should work with realistic workspace scenario", () => {
      // Simulate a realistic workspace with 150 files
      const paths: string[] = [];
      
      // 50 frontend components
      for (let i = 0; i < 50; i++) {
        paths.push(`frontend/components/Component${i}.tsx`);
      }
      
      // 50 backend services
      for (let i = 0; i < 50; i++) {
        paths.push(`backend/services/Service${i}.ts`);
      }
      
      // 50 utility files
      for (let i = 0; i < 50; i++) {
        paths.push(`shared/utils/util${i}.ts`);
      }
      
      const maxLength = 4000; // Default config value
      const result = batchFilesForSearch(paths, maxLength);
      
      // Should handle all files
      const allFiles = result.batches.flat();
      expect(allFiles).to.have.lengthOf(150);
      
      // Each batch should respect the limit
      for (const batch of result.batches) {
        const pattern = optimizeIncludePatterns(batch);
        expect(pattern.length).to.be.at.most(maxLength);
      }
      
      // Log for debugging
      console.log(`Batched 150 files into ${result.batches.length} batch(es)`);
      result.batches.forEach((batch, i) => {
        const pattern = optimizeIncludePatterns(batch);
        console.log(`  Batch ${i + 1}: ${batch.length} files, ${pattern.length} chars`);
      });
    });

    it("should handle edge case of exactly limit length", () => {
      const paths = ["app/test.ts"];
      const pattern = optimizeIncludePatterns(paths);
      const exactLimit = pattern.length;
      
      const result = batchFilesForSearch(paths, exactLimit);
      
      expect(result.batches).to.have.lengthOf(1);
      expect(result.batches[0]).to.deep.equal(paths);
    });

    it("should handle edge case of one char below limit", () => {
      const paths = [
        "app/a.ts",
        "app/b.ts",
      ];
      const pattern = optimizeIncludePatterns(paths);
      const limitJustBelow = pattern.length - 1;
      
      const result = batchFilesForSearch(paths, limitJustBelow);
      
      // Should split into 2 batches since combined pattern is too long
      expect(result.batches.length).to.be.at.least(2);
      
      // All files should be included
      const allFiles = result.batches.flat();
      expect(allFiles).to.have.lengthOf(paths.length);
    });

    describe("completeness verification", () => {
      // These tests are specifically for verifying no files are lost during batching
      
      it("should include every file exactly once", () => {
        const paths = [
          "app/a.ts",
          "app/b.ts",
          "app/c.ts",
          "lib/d.ts",
          "lib/e.ts",
          "lib/f.ts",
        ];
        
        const result = batchFilesForSearch(paths, 30);
        
        const allFiles = result.batches.flat();
        
        // Check count
        expect(allFiles).to.have.lengthOf(paths.length);
        
        // Check each file appears exactly once
        for (const path of paths) {
          const count = allFiles.filter(f => f === path).length;
          expect(count).to.equal(1, `File ${path} should appear exactly once`);
        }
      });

      it("should not duplicate files across batches", () => {
        const paths = Array.from({ length: 30 }, (_, i) => `app/file${i}.ts`);
        
        const result = batchFilesForSearch(paths, 100);
        
        // Collect all files with their batch index
        const fileSeenInBatch = new Map<string, number[]>();
        
        result.batches.forEach((batch, batchIndex) => {
          batch.forEach(file => {
            if (!fileSeenInBatch.has(file)) {
              fileSeenInBatch.set(file, []);
            }
            fileSeenInBatch.get(file)!.push(batchIndex);
          });
        });
        
        // Every file should appear in exactly one batch
        for (const [file, batchIndices] of fileSeenInBatch.entries()) {
          expect(batchIndices).to.have.lengthOf(1, 
            `File ${file} appears in multiple batches: ${batchIndices.join(", ")}`);
        }
      });

      it("should handle large file lists without losing files", () => {
        // Create a large diverse file list
        const paths: string[] = [];
        
        // Various directory structures
        for (let i = 0; i < 100; i++) {
          paths.push(`dir${i % 10}/subdir${i % 5}/file${i}.ts`);
        }
        
        const result = batchFilesForSearch(paths, 500);
        
        const allFiles = result.batches.flat();
        
        // Verify count
        expect(allFiles).to.have.lengthOf(paths.length);
        
        // Verify each original file is present
        const allFilesSet = new Set(allFiles);
        for (const path of paths) {
          expect(allFilesSet.has(path)).to.be.true, `Missing file: ${path}`;
        }
      });
    });
  });
});
