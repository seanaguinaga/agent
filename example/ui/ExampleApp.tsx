import { Suspense, useState } from "react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { examples } from "./examples";
import { ExampleBoundary } from "./components/Example";
import { Toaster } from "./components/ui/toaster";

export default function ExampleApp() {
  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col bg-gray-50">
        <header className="sticky top-0 z-50 border-b bg-white/95 px-4 py-4 backdrop-blur-sm sm:px-8">
          <nav
            className="mx-auto flex max-w-7xl items-center justify-between gap-4"
            aria-label="Main navigation"
          >
            <Link to="/" className="text-lg font-semibold tracking-tight">
              Agent Examples
            </Link>
            <span className="text-xs text-gray-500">
              {examples.length} demos · Convex Agent
            </span>
          </nav>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <ExampleRoutes />
        </div>
        <Toaster />
      </div>
    </BrowserRouter>
  );
}
function ExampleRoutes() {
  const location = useLocation();
  return (
    <ExampleBoundary key={location.pathname}>
      <Suspense
        fallback={
          <p role="status" className="p-8 text-center text-gray-500">
            Loading example…
          </p>
        }
      >
        <Routes>
          <Route path="/" element={<Catalog />} />
          {examples.map((example) => (
            <Route
              key={example.path}
              path={example.path}
              element={example.element}
            />
          ))}
          <Route
            path="*"
            element={
              <div className="p-8">
                <h1 className="text-2xl font-semibold">Example not found</h1>
                <Link to="/" className="link-text">
                  View all examples
                </Link>
              </div>
            }
          />
        </Routes>
      </Suspense>
    </ExampleBoundary>
  );
}
function Catalog() {
  const [search, setSearch] = useState("");
  const filtered = examples.filter((example) =>
    `${example.title} ${example.description} ${example.source}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const groups = [...new Set(filtered.map((example) => example.group))];
  return (
    <main className="mx-auto max-w-7xl space-y-10 px-4 py-10 sm:px-8">
      <div className="max-w-3xl">
        <p className="text-sm font-medium uppercase tracking-widest text-blue-600">
          The example collection
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Explore what agents can do.
        </h1>
        <p className="mt-4 text-lg text-gray-600">
          Run the examples, inspect conversations, and see the component in
          action. From a first message to tools, knowledge, and durable
          workflows.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <label htmlFor="search" className="sr-only">
            Find an example
          </label>
          <input
            id="search"
            type="search"
            className="input-field max-w-xl bg-white"
            placeholder="Find an example by name, feature, or source file…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <p className="text-sm text-gray-500" role="status">
          {filtered.length} of {examples.length} examples
        </p>
      </div>
      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
        Text demos use your configured provider or the Convex AI Gateway.
        Reasoning, structured output, images, and embeddings need the providers
        noted on their screens. Gateway access requires a linked deployment on
        an eligible Convex team.
      </div>
      {groups.map((group) => (
        <section key={group} aria-label={group}>
          <h2 className="mb-4 text-xl font-semibold">{group}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered
              .filter((example) => example.group === group)
              .map((example) => (
                <Link
                  key={example.path}
                  to={example.path}
                  className="group flex flex-col rounded-xl border bg-white p-5 transition hover:border-blue-400 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                >
                  <h3 className="flex justify-between gap-2 font-semibold group-hover:text-blue-700">
                    {example.title}
                    <span aria-hidden="true" className="text-gray-400">
                      ↗
                    </span>
                  </h3>
                  <p className="mt-2 flex-1 text-sm leading-6 text-gray-600">
                    {example.description}
                  </p>
                  <code className="mt-5 break-all text-xs text-gray-400">
                    {example.source}
                  </code>
                </Link>
              ))}
          </div>
        </section>
      ))}
      {filtered.length === 0 && (
        <p className="text-gray-500">
          No matching examples. Try “stream”, “files”, or “tools”.
        </p>
      )}
    </main>
  );
}
