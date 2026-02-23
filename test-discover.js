const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
const PROJECTS_DIR = path.join(DATA_DIR, "workspace");

const projects = [];

const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const projectPath = path.join(PROJECTS_DIR, entry.name);
  const packageJsonPath = path.join(projectPath, "package.json");

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const scripts = packageJson.scripts || {};

      let suggestedCommand = "npm run dev";
      if (scripts.start && !scripts.dev) {
        suggestedCommand = "npm start";
      } else if (scripts.dev) {
        suggestedCommand = "npm run dev";
      }

      const basePort = 3000;
      const portHash = entry.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const suggestedPort = basePort + (portHash % 1000);

      projects.push({
        name: entry.name,
        path: projectPath,
        hasPackageJson: true,
        suggestedCommand,
        suggestedPort,
      });
    } catch (e) {
      console.log("Error parsing", entry.name, e.message);
    }
  }
}

console.log("Found", projects.length, "projects:");
projects.forEach(p => console.log("-", p.name, "|", p.suggestedCommand, "| port:", p.suggestedPort));
