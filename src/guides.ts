import { promises as fs } from 'node:fs';
import path from 'node:path';

// Authored instructions served to agents by `research guide` and as MCP prompts. Paths are relative to the package root.
export const guides: Record<string, { file: string; description: string }> = {
  agent: { file: 'docs/guides/agent-prompt.md', description: 'Session prompt: tools, the records to build, relations, rules, self-check.' },
  'project-overview': { file: 'docs/guides/project-overview-skill.md', description: 'Project overview as an argument; stage claims; the authored research map.' },
  experiment: { file: 'docs/guides/experiment-instruction.md', description: 'Experiment placement, brief, decision rule, observation, figures.' },
  'related-work': { file: 'docs/guides/related-work-instruction.md', description: 'Paper records: metadata, body sections, links to our claims and experiments.' },
  'back-burner': { file: 'docs/guides/back-burner-instruction.md', description: 'Claim loop from brief to verdict, and pruning decided or outdated work to the back burner.' },
  'report-and-files': { file: 'docs/guides/report-and-files-instruction.md', description: 'The Overleaf report (status, sync, outline, section reading; the researcher publishes) and Drive/web files linked from records.' },
  ponytail: { file: 'skills/ponytail/SKILL.md', description: 'Default coding principles: the smallest complete change (MIT, DietrichGebert/ponytail).' },
};

export async function readGuide(name: string, root = path.resolve(__dirname, '..')) {
  const guide = guides[name];
  if (!guide) throw new Error(`Unknown guide: ${name}. Available: ${Object.keys(guides).join(', ')}`);
  return fs.readFile(path.join(root, guide.file), 'utf8');
}
