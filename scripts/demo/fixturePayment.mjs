// Versions of src/checkout/payment.ts for the blame heatmap scenes. Each version
// edits different lines, so Age mode shows several ages and Baseline mode (vs the
// v1.0.0 tag) shows modified, added and deleted lines plus an uncommitted edit.

const HEADER = `import { Order } from "../cart/cart";
import { Gateway } from "./gateway";

export interface PaymentResult {
  ok: boolean;
  reference?: string;
  error?: string;
}
`;

/** 85 days ago: first version. */
export const PAYMENT_V1 = `${HEADER}
const MAX_AMOUNT = 10_000;

export async function pay(order: Order, gateway: Gateway): Promise<PaymentResult> {
  if (order.total <= 0) {
    return { ok: false, error: "Nothing to pay" };
  }
  if (order.total > MAX_AMOUNT) {
    return { ok: false, error: "Amount over limit" };
  }

  const response = await gateway.charge(order.id, order.total);
  if (!response.accepted) {
    return { ok: false, error: response.message };
  }
  return { ok: true, reference: response.reference };
}

export function isRefundable(result: PaymentResult): boolean {
  return result.ok && result.reference !== undefined;
}

export function formatReference(reference: string): string {
  return reference.toUpperCase();
}
`;

/** 40 days ago, before the baseline: clearer errors. */
export const PAYMENT_V2 = PAYMENT_V1
  .replace(`error: "Nothing to pay"`, `error: "Order total must be positive"`)
  .replace(`error: "Amount over limit"`, `error: \`Order total exceeds \${MAX_AMOUNT}\``);

/** 12 days ago, after the baseline: per-currency limit, refund check removed, reference format changed. */
export const PAYMENT_V3 = PAYMENT_V2
  .replace("const MAX_AMOUNT = 10_000;", `const MAX_AMOUNT: Record<string, number> = { EUR: 10_000, USD: 12_000 };`)
  .replace("if (order.total > MAX_AMOUNT) {", "if (order.total > MAX_AMOUNT[order.currency]) {")
  .replace("exceeds ${MAX_AMOUNT}", "exceeds ${MAX_AMOUNT[order.currency]} ${order.currency}")
  .replace("return reference.toUpperCase();", "return `PAY-${reference.slice(0, 8).toUpperCase()}`;")
  .replace(`
export function isRefundable(result: PaymentResult): boolean {
  return result.ok && result.reference !== undefined;
}
`, "");

/** 5 days ago: retry transient gateway failures. */
export const PAYMENT_V4 = PAYMENT_V3.replace(
  "  const response = await gateway.charge(order.id, order.total);\n",
  `  let response = await gateway.charge(order.id, order.total);
  for (let attempt = 1; attempt < 3 && response.transient; attempt++) {
    await delay(attempt * 500);
    response = await gateway.charge(order.id, order.total);
  }
`,
).replace(`import { Gateway } from "./gateway";`, `import { Gateway } from "./gateway";\nimport { delay } from "./retry";`);

/** Uncommitted: log declined payments. */
export const PAYMENT_PENDING = PAYMENT_V4.replace(
  "  if (!response.accepted) {\n",
  "  if (!response.accepted) {\n    console.warn(`Payment declined for order ${order.id}`);\n",
);
