/**
 * orrith.config.js example
 *
 * Place this file at the root of your "ops" directory (where STATE.md / backlog.md live)
 * and run `npx orrith` from that directory.
 */
export default {
  sources: {
    // root: 'absolute or relative path' (default: process.cwd())
    state: 'STATE.md',
    backlog: 'backlog.md',
    roadmaps: 'roadmaps.md',
    todosDir: 'todos',
  },
  parsers: {
    // Markdown section names that orrith looks for in your STATE.md
    state: {
      phaseSection: 'Current Phase',     // matches `## Current Phase`
      roadmapSection: 'Current Roadmap', // matches `## Current Roadmap`
    },
    backlog: {
      // Regex to extract category headings like "## A. Some Label [ACTIVE]"
      categoryRegex: '^##\\s+([A-Z])\\.\\s+([^\\n]+)',
    },
  },
  preset: 'pixel', // pixel | visor | monolith | doodle | minimal
  port: 3838,
}
