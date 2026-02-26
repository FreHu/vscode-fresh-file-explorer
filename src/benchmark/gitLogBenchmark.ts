import { execGitWithArgs, RepoInfo, streamGitLogNameStatus } from "../git/gitOperations";
import { log } from "../utils/logger";
import { Benchmark, BenchmarkInputSpec, BenchmarkInputValues, BenchmarkOutputRow } from "./benchmark";

const sharedInputSpec : BenchmarkInputSpec = {
    params: [
        { name: "days",     type: "number", default: "7,30,90", multi: true },
        { name: "pathspec", type: "string", default: "" },
    ],
};

export function createGitLogBenchmark(repos: RepoInfo[]): Benchmark {
    return {
        name: "Git Log (buffered, --name-status)",
        inputSpec: sharedInputSpec,
        outputSpec: {
            columns: [
                { name: "repo",      type: "string" },
                { name: "days",      type: "number" },
                { name: "elapsedMs", type: "number", format: "duration-ms", comparison: "ratioWithPrevious" },
                { name: "lines",     type: "number" },  // raw output line count
                { name: "bytes",     type: "number", format: "bytes", comparison: "ratioWithPrevious" },
                { name: "error",     type: "string", role: "error" },
            ],
        },
        async run(inputs: BenchmarkInputValues): Promise<BenchmarkOutputRow[]> {
            const days = inputs["days"] as number;
            const pathspec = inputs["pathspec"] as string;
            const args = buildArgs(days, "--name-status", pathspec);
            return Promise.all(repos.map(async repo => {
                log(`[git-log-benchmark] git ${args.join(" ")} in ${repo.name}`);
                const start = Date.now();
                try {
                    const output = await execGitWithArgs(args, repo.path);
                    return {
                        repo: repo.name, 
                        days, 
                        elapsedMs: Date.now() - start, 
                        lines: output ? output.split("\n").length : 0, 
                        bytes: Buffer.byteLength(output, "utf8"), 
                        error: ""
                    };
                } catch (err: any) {
                    return { 
                        repo: repo.name, 
                        days, 
                        elapsedMs: Date.now() - start, 
                        lines: 0, 
                        bytes: 0, 
                        error: String(err) 
                    };
                }
            }));
        },
    };
}

export function createGitLogStreamBenchmark(repos: RepoInfo[]): Benchmark {
    return {
        name: "Git Log (streaming, --name-status)",
        inputSpec: sharedInputSpec,
        outputSpec: {
            columns: [
                { name: "repo",      type: "string" },
                { name: "days",      type: "number" },
                { name: "elapsedMs", type: "number", format: "duration-ms", comparison: "ratioWithPrevious" },
                { name: "files",     type: "number" },
                { name: "error",     type: "string", role: "error" },
            ],
        },
        async run(inputs: BenchmarkInputValues): Promise<BenchmarkOutputRow[]> {
            const days = inputs["days"] as number;
            const pathspec = inputs["pathspec"] as string;
            const args = buildArgs(days, "--name-status", pathspec);
            return Promise.all(repos.map(async repo => {
                log(`[git-log-stream-benchmark] git ${args.join(" ")} in ${repo.name}`);
                const start = Date.now();
                try {
                    const fileMap = await streamGitLogNameStatus(args, repo.path, "", undefined);
                    return { 
                        repo: repo.name, 
                        days, 
                        elapsedMs: Date.now() - start, 
                        files: fileMap.size, 
                        error: "" 
                    };
                } catch (err: any) {
                    return { 
                        repo: repo.name, 
                        days, 
                        elapsedMs: Date.now() - start, 
                        files: 0, 
                        error: String(err) };
                }
            }));
        },
    };
}

export function createGitNumstatBenchmark(repos: RepoInfo[]): Benchmark {
    return {
        name: "Git Log (buffered, --numstat)",
        inputSpec: sharedInputSpec,
        outputSpec: {
            columns: [
                { name: "repo",      type: "string" },
                { name: "days",      type: "number" },
                { name: "elapsedMs", type: "number", format: "duration-ms", comparison: "ratioWithPrevious" },
                { name: "lines",     type: "number" },  // raw output line count (additions+deletions rows)
                { name: "bytes",     type: "number", format: "bytes", comparison: "ratioWithPrevious" },
                { name: "error",     type: "string", role: "error" },
            ],
        },
        async run(inputs: BenchmarkInputValues): Promise<BenchmarkOutputRow[]> {
            const days = inputs["days"] as number;
            const pathspec = inputs["pathspec"] as string;
            const args = buildArgs(days, "--numstat", pathspec);
            return Promise.all(repos.map(async repo => {
                log(`[git-numstat-benchmark] git ${args.join(" ")} in ${repo.name}`);
                const start = Date.now();
                try {
                    const output = await execGitWithArgs(args, repo.path);
                    return { 
                        repo: repo.name, 
                        days, 
                        elapsedMs: Date.now() - start, 
                        lines: output ? output.split("\n").length : 0, 
                        bytes: Buffer.byteLength(output, "utf8"), 
                        error: "" 
                    };
                } catch (err: any) {
                    return { 
                        repo: repo.name, 
                        days, 
                        elapsedMs: Date.now() - start, 
                        lines: 0, 
                        bytes: 0, 
                        error: String(err) 
                    };
                }
            }));
        },
    };
}


function buildArgs(days: number, modeFlag: string, pathspec: string): string[] {
    return [
        "log",
        `--since=${days}.days.ago`,
        modeFlag,
        "--pretty=format:__COMMIT__%h|%an|%aI|%s",
        ...(pathspec ? ["--", pathspec] : []),
    ];
}