import { useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { ExampleBoundary, ExamplePage, Result } from "../components/Example";

export default function UsageTracking() {
  const [month, setMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  return (
    <ExamplePage
      title="Usage and invoices"
      description="Inspect token usage and existing invoices for the demo user. Invoice generation stays internal; this page does not charge anyone."
    >
      <div className="demo-panel">
        <label className="demo-label" htmlFor="month">
          Billing month
        </label>
        <input
          id="month"
          type="month"
          className="input-field"
          required
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
        <p className="text-sm text-gray-600">
          Send a message in{" "}
          <Link to="/chat-basic" className="link-text">
            Basic Chat
          </Link>{" "}
          to record usage. The preview shows up to 100 records per table.
        </p>
      </div>
      {month && (
        <ExampleBoundary key={month}>
          <Usage billingPeriod={`${month}-01`} />
        </ExampleBoundary>
      )}
    </ExamplePage>
  );
}
function Usage({ billingPeriod }: { billingPeriod: string }) {
  const usage = useQuery(api.usage_tracking.dashboard.listUsage, {
    billingPeriod,
  });
  const invoices = useQuery(api.usage_tracking.dashboard.listInvoices, {
    billingPeriod,
  });
  if (!usage || !invoices)
    return <p role="status">Loading usage and invoices…</p>;
  const input = usage.reduce(
    (sum, row) => sum + (row.usage.promptTokens ?? 0),
    0,
  );
  const output = usage.reduce(
    (sum, row) => sum + (row.usage.completionTokens ?? 0),
    0,
  );
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Requests", usage.length],
          ["Input tokens", input],
          ["Output tokens", output],
        ].map(([label, value]) => (
          <div className="demo-panel" key={label}>
            <p className="text-sm text-gray-500">{label}</p>
            <p className="text-3xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="demo-panel">
        <h2 className="font-semibold">Usage records</h2>
        {usage.length ? (
          <Result value={usage} />
        ) : (
          <p className="text-gray-500">No recorded usage this month.</p>
        )}
      </div>
      <div className="demo-panel">
        <h2 className="font-semibold">Invoices</h2>
        {invoices.length ? (
          <Result value={invoices} />
        ) : (
          <p className="text-gray-500">
            No invoices have been generated for this month.
          </p>
        )}
      </div>
    </>
  );
}
