import type { DomainHandler, CallToolResult } from '../utils/types.js';
import { okResult, errorResult } from '../render.js';
import { UNKNOWN_TOOL_MESSAGE } from '../errors.js';
import { logger } from '../utils/logger.js';
import { pipelineTool, runPipelineSummary } from '../reports/pipeline.js';
import { funnelTool, runQuoteConversionFunnel } from '../reports/funnel.js';
import { marginTool, runSalesOrderMargin } from '../reports/margin.js';
import { spendTool, runCustomerSpend } from '../reports/spend.js';
import { velocityTool, runProductVelocity } from '../reports/velocity.js';
import { reconciliationTool, runPurchaseVsSales } from '../reports/reconciliation.js';

type Report = (args: Record<string, unknown>) => Promise<unknown>;

const REPORTS: Array<{ tool: typeof pipelineTool; run: Report }> = [
  { tool: pipelineTool, run: runPipelineSummary },
  { tool: funnelTool, run: runQuoteConversionFunnel },
  { tool: marginTool, run: runSalesOrderMargin },
  { tool: spendTool, run: runCustomerSpend },
  { tool: velocityTool, run: runProductVelocity },
  { tool: reconciliationTool, run: runPurchaseVsSales },
];

async function handleCall(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const report = REPORTS.find((r) => r.tool.name === toolName);
  if (!report) return errorResult(UNKNOWN_TOOL_MESSAGE);
  logger.info(`Report: ${toolName}`);
  return okResult(await report.run(args));
}

export const reportsHandler: DomainHandler = { getTools: () => REPORTS.map((r) => r.tool), handleCall };
