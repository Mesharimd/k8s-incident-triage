import { describe, expect, test } from "bun:test";

async function readRepositoryFile(path: string): Promise<string> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

async function repositoryFileExists(path: string): Promise<boolean> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).exists();
}

describe("continuous integration workflow contract", () => {
  test("runs the strict Bun checks reproducibly with least privilege", async () => {
    const workflowPath = ".github/workflows/ci.yml";

    expect(await repositoryFileExists(workflowPath)).toBe(true);

    const workflow = await readRepositoryFile(workflowPath);

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toMatch(
      /^\s+uses: actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4\.3\.1\s*$/m,
    );
    expect(workflow).toMatch(
      /^\s+uses: oven-sh\/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76 # v2\.0\.2\s*$/m,
    );

    const actionReferences = workflow
      .split("\n")
      .filter((line) => /^\s*uses:/.test(line));
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(
        /^\s*uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}(?:\s+#\s+.+)?\s*$/,
      );
    }

    expect(workflow).toContain("bun-version: 1.2.15");
    expect(workflow).toMatch(/^\s+run: bun install --frozen-lockfile\s*$/m);
    expect(workflow).toMatch(/^\s+run: bun run typecheck\s*$/m);
    expect(workflow).toMatch(/^\s+run: bun test\s*$/m);
    expect(workflow).toMatch(/^\s+run: make check-demo-rules\s*$/m);
    expect(workflow).toMatch(/^\s+run: make check-chart\s*$/m);
    expect(workflow).not.toMatch(/\bsecrets\b/i);
  });
});
