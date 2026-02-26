/** Schema for a single input parameter, shown as a form field in the UI. */
export interface BenchmarkParamSpec {
    name: string,
    type: "string" | "number" | "boolean",
    default?: string | number | boolean,
    /** When true, the field accepts comma-separated values and the benchmark is run once per value. */
    multi?: true
}

/** Schema for a single output column, used to build the results table. */
export interface BenchmarkColumnSpec {
    name: string,
    type: "string" | "number" | "boolean",
    /** Optional rendering hint for number columns. */
    format?: "bytes" | "duration-ms",
    /** Renders an extra column after this one showing the ratio or difference vs the previous row. */
    comparison?: "ratioWithPrevious" | "differenceFromPrevious",
    /** Mark the column that holds error text; rows with a non-empty value get error styling. */
    role?: "error"
}

export interface BenchmarkInputSpec {
    params: BenchmarkParamSpec[]
}

export interface BenchmarkOutputSpec {
    columns: BenchmarkColumnSpec[]
}

/** Resolved input values passed to `run`, keyed by param name. */
export type BenchmarkInputValues = Record<string, string | number | boolean>;

/** A single row of benchmark output, keyed by column name. */
export type BenchmarkOutputRow = Record<string, string | number | boolean>;

export interface Benchmark {
    name: string,
    inputSpec: BenchmarkInputSpec,
    outputSpec: BenchmarkOutputSpec,
    run: (inputs: BenchmarkInputValues) => Promise<BenchmarkOutputRow[]>
}
