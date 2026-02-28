import * as assert from "assert";
import { normalizeRemoteUrl, detectHostKind, buildRemoteFileUrl } from "../../commands/copyRemoteUrlCommand";

// ---------------------------------------------------------------------------
// normalizeRemoteUrl
// ---------------------------------------------------------------------------

suite("copyRemoteUrlCommand", () => {
  suite("normalizeRemoteUrl", () => {
    // HTTPS — strip .git and trailing slash
    test("strips .git suffix from HTTPS URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    test("HTTPS URL without .git is unchanged (except whitespace)", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://github.com/user/repo"),
        "https://github.com/user/repo",
      );
    });

    test("strips credentials from HTTPS URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://mytoken@github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    test("strips user:token credentials from HTTPS URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://user:somepassword@github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    test("strips trailing newline from git output", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://github.com/user/repo.git\n"),
        "https://github.com/user/repo",
      );
    });

    // SCP-style SSH
    test("normalizes SCP-style GitHub SSH URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("git@github.com:user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    test("normalizes SCP-style GitLab SSH URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("git@gitlab.com:group/project.git"),
        "https://gitlab.com/group/project",
      );
    });

    test("normalizes SCP-style Bitbucket SSH URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("git@bitbucket.org:user/repo.git"),
        "https://bitbucket.org/user/repo",
      );
    });

    // ssh:// scheme
    test("normalizes ssh:// GitHub URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("ssh://git@github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    // Azure DevOps SSH
    test("normalizes Azure DevOps SSH URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("git@ssh.dev.azure.com:v3/myorg/myproject/myrepo"),
        "https://dev.azure.com/myorg/myproject/_git/myrepo",
      );
    });

    test("normalizes Azure DevOps HTTPS URL with user@", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://myuser@dev.azure.com/myorg/myproject/_git/myrepo"),
        "https://dev.azure.com/myorg/myproject/_git/myrepo",
      );
    });

    // Legacy visualstudio.com
    test("normalizes legacy visualstudio.com URL", () => {
      assert.strictEqual(
        normalizeRemoteUrl("https://myorg.visualstudio.com/myproject/_git/myrepo"),
        "https://dev.azure.com/myorg/myproject/_git/myrepo",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // detectHostKind
  // ---------------------------------------------------------------------------

  suite("detectHostKind", () => {
    test("detects github.com", () => {
      assert.strictEqual(detectHostKind("https://github.com/user/repo"), "github");
    });

    test("detects gitlab.com", () => {
      assert.strictEqual(detectHostKind("https://gitlab.com/group/project"), "gitlab");
    });

    test("detects bitbucket.org", () => {
      assert.strictEqual(detectHostKind("https://bitbucket.org/user/repo"), "bitbucket");
    });

    test("detects Azure DevOps (dev.azure.com)", () => {
      assert.strictEqual(
        detectHostKind("https://dev.azure.com/org/project/_git/repo"),
        "azuredevops",
      );
    });

    test("returns unknown for unrecognised host", () => {
      assert.strictEqual(detectHostKind("https://my.selfhosted.git/user/repo"), "unknown");
    });
  });

  // ---------------------------------------------------------------------------
  // buildRemoteFileUrl
  // ---------------------------------------------------------------------------

  suite("buildRemoteFileUrl", () => {
    // GitHub
    test("GitHub: file URL", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://github.com/user/repo", "main", "src/foo.ts", false),
        "https://github.com/user/repo/blob/main/src/foo.ts",
      );
    });

    test("GitHub: directory URL uses tree", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://github.com/user/repo", "main", "src/utils", true),
        "https://github.com/user/repo/tree/main/src/utils",
      );
    });

    test("GitHub: repo root (empty path)", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://github.com/user/repo", "main", "", false),
        "https://github.com/user/repo",
      );
    });

    test("GitHub: branch with slashes is percent-encoded", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://github.com/user/repo", "feature/my-feature", "src/foo.ts", false),
        "https://github.com/user/repo/blob/feature%2Fmy-feature/src/foo.ts",
      );
    });

    // GitLab
    test("GitLab: file URL", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://gitlab.com/group/project", "develop", "lib/bar.rb", false),
        "https://gitlab.com/group/project/-/blob/develop/lib/bar.rb",
      );
    });

    test("GitLab: directory URL uses tree", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://gitlab.com/group/project", "develop", "lib", true),
        "https://gitlab.com/group/project/-/tree/develop/lib",
      );
    });

    // Bitbucket
    test("Bitbucket: file URL", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://bitbucket.org/user/repo", "master", "src/index.js", false),
        "https://bitbucket.org/user/repo/src/master/src/index.js",
      );
    });

    test("Bitbucket: directory URL gets trailing slash", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://bitbucket.org/user/repo", "master", "src", true),
        "https://bitbucket.org/user/repo/src/master/src/",
      );
    });

    test("Bitbucket: repo root (empty path)", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://bitbucket.org/user/repo", "master", "", false),
        "https://bitbucket.org/user/repo/src/master/",
      );
    });

    // Azure DevOps
    test("Azure DevOps: file URL", () => {
      assert.strictEqual(
        buildRemoteFileUrl(
          "https://dev.azure.com/org/project/_git/repo",
          "main",
          "src/foo.ts",
          false,
        ),
        "https://dev.azure.com/org/project/_git/repo?path=/src/foo.ts&version=GBmain",
      );
    });

    test("Azure DevOps: directory URL (no structural difference)", () => {
      assert.strictEqual(
        buildRemoteFileUrl(
          "https://dev.azure.com/org/project/_git/repo",
          "main",
          "src",
          true,
        ),
        "https://dev.azure.com/org/project/_git/repo?path=/src&version=GBmain",
      );
    });

    test("Azure DevOps: repo root (empty path)", () => {
      assert.strictEqual(
        buildRemoteFileUrl(
          "https://dev.azure.com/org/project/_git/repo",
          "main",
          "",
          false,
        ),
        "https://dev.azure.com/org/project/_git/repo?path=/&version=GBmain",
      );
    });

    // Unknown host
    test("unknown host returns undefined", () => {
      assert.strictEqual(
        buildRemoteFileUrl("https://my.selfhosted.git/user/repo", "main", "src/foo.ts", false),
        undefined,
      );
    });
  });
});
