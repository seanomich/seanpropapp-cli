/**
 * SeanPropApp methodology module manifest.
 *
 * Mirrors `packages/mcp-server/src/manifest.ts` in the proposition-app monorepo.
 * Metadata only: zero analytical content lives here. Module prompts are
 * assembled server-side via /api/mcp/assemble-prompt.
 *
 * Keep this list in sync with the upstream registry. Drift between this file
 * and the registry will surface as 400s from /api/mcp/assemble-prompt at runtime.
 */
export interface ModuleManifestEntry {
  id: string;
  displayName: string;
  description: string;
}

export const MODULES: ModuleManifestEntry[] = [
  {
    id: "EXEC_SUMMARY",
    displayName: "Executive Summary",
    description:
      "Board-ready synthesis tying market, customer, competition, and economics into one decision narrative. Best run after the research modules.",
  },
  {
    id: "SETUP",
    displayName: "Initial Framing",
    description:
      "START HERE. Establishes the company's context, sector, and business model so every later module reasons from the right baseline.",
  },
  {
    id: "TAM_SIZING",
    displayName: "Market Sizing & TAM",
    description:
      "Sizes the opportunity (TAM / SAM / SOM + segment prioritization) to test whether the market is big enough to matter.",
  },
  {
    id: "ICP",
    displayName: "Ideal Customer Profile",
    description:
      "Pinpoints the highest-fit customer segments and the personas who actually buy.",
  },
  {
    id: "JTBD",
    displayName: "Jobs To Be Done",
    description:
      "Uncovers the real job customers hire this for: their pains, desired outcomes, and switch triggers.",
  },
  {
    id: "COMPETITIVE",
    displayName: "Competitive Landscape",
    description:
      "Maps the competitive field and where you genuinely differentiate vs. where you don't.",
  },
  {
    id: "POSITIONING",
    displayName: "Positioning Statement",
    description:
      "Turns the research into a sharp positioning statement: who it's for, what it is, why it wins.",
  },
  {
    id: "PITCHES",
    displayName: "Elevator Pitches",
    description:
      "Audience-tuned elevator pitches (exec, customer, investor) you can use verbatim.",
  },
  {
    id: "QUOTES",
    displayName: "Customer Quotes",
    description:
      "Illustrative customer/stakeholder quotes that make the value concrete and testable.",
  },
  {
    id: "PRESS_RELEASE",
    displayName: "Future Press Release",
    description:
      "Amazon Working-Backwards future press release: forces clarity on the outcome you're building toward.",
  },
  {
    id: "DISCOVERY",
    displayName: "Discovery & Validation Plan",
    description:
      "A concrete plan to validate the riskiest assumptions before you over-invest.",
  },
  {
    id: "GAP",
    displayName: "Gap Analysis",
    description:
      "Surfaces gaps between today's reality and the proposition: what must be true to win.",
  },
  {
    id: "VALUE_STACK",
    displayName: "Value Stack",
    description:
      "Builds the value stack and pressure-tests it against the 'do nothing / DIY' alternative.",
  },
  {
    id: "MOAT",
    displayName: "Moat Deep Dive",
    description:
      "Assesses durable advantage: what stops a competitor from copying this within a year.",
  },
  {
    id: "UNIT_ECON",
    displayName: "Unit Economics",
    description:
      "Unit economics, cost-to-serve, pricing mechanics, and revenue scenarios: does the model pay?",
  },
  {
    id: "TOP_QUESTIONS",
    displayName: "Top Questions & Action Plan",
    description:
      "The critical unanswered questions plus an action plan to resolve them.",
  },
  {
    id: "IDEAS",
    displayName: "Five Additional Ideas",
    description:
      "Five adjacent initiative or investment ideas worth exploring next.",
  },
];
