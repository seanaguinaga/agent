import { ExamplePage } from "../components/Example";

export default function Playground() {
  return (
    <ExamplePage
      title="Agent playground"
      description="The repository already includes a full playground for convex/playground.ts: browse users, agents and threads, inspect context, and send messages."
    >
      <div className="demo-panel">
        <h2 className="font-semibold">Connect the existing playground</h2>
        <p>Start it from this repository in another terminal:</p>
        <pre className="overflow-auto rounded-lg bg-gray-50 p-3 text-sm">
          npm run dev --workspace playground -- --port 5174
        </pre>
        <a
          className="link-text inline-block"
          href="http://localhost:5174/play"
          target="_blank"
          rel="noreferrer"
        >
          Open local playground ↗
        </a>
        <p>Use this deployment URL in its settings:</p>
        <pre className="overflow-auto rounded-lg bg-gray-50 p-3 text-sm">
          {import.meta.env.VITE_CONVEX_URL}
        </pre>
        <p>Issue a local playground key, then paste it into those settings:</p>
        <pre className="overflow-auto rounded-lg bg-gray-50 p-3 text-sm">
          npx convex run --component agent apiKeys:issue
        </pre>
        <p className="text-sm text-gray-500">
          The key is managed by the existing playground. It grants access to the
          demo deployment.
        </p>
      </div>
    </ExamplePage>
  );
}
