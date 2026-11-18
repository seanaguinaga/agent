#!/usr/bin/env node

const { join } = require("path");
const { execSync } = require("child_process");

// Check if --init flag is passed
const initFlag = process.argv.includes("--init");

console.log("Installing dependencies for the Agent component...");
execSync("npm install", { cwd: __dirname, stdio: "inherit" });
console.log("✅\n");
console.log("Building the Agent component...");
execSync("npm run build", { cwd: __dirname, stdio: "inherit" });
console.log("✅\n");
console.log("Installing dependencies for the playground...");
execSync("npm install", {
  cwd: join(__dirname, "./playground"),
  stdio: "inherit",
});
console.log("✅\n");

if (initFlag) {
  console.log("🚀 Starting interactive setup...\n");

  try {
    console.log("Checking backend configuration...");
    execSync("npx convex dev --once", {
      cwd: __dirname,
      stdio: "inherit",
      stderr: "inherit",
    });
    console.log("✅ Backend setup complete! Model requests use Convex AI Gateway.");
  } catch (error) {
    console.error("❌ Backend setup failed:", error);
    process.exitCode = 1;
  }
} else {
  console.log("Now run: npm run dev");
}
