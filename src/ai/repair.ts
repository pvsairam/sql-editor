import * as vscode from 'vscode';
import { Connection } from '../model';
import { ConnectionManager } from '../connections/ConnectionManager';
import { SchemaService } from '../schema/SchemaService';
import { FusionError, errorMessage } from '../fusion/errors';
import { Logger } from '../fusion/types';
import { tablesInStatement } from '../sql/completion';
import { analyzeFusionSql, extractSqlBlock, isReadOnlySql, neutralizeBindsForValidation, SqlWarning, wrapValidationQuery } from './sqlAnalyzer';
import { completePrompt } from './llmClient';
import { settings } from '../config';

export interface RepairAttempt {
  attempt: number;
  sql: string;
  error?: string;
}

export interface ValidateRepairResult {
  ok: boolean;
  sql: string;
  repaired: boolean;
  attempts: RepairAttempt[];
  sampleRowCount?: number;
  columns?: string[];
  warnings: SqlWarning[];
  error?: string;
}

/**
 * Strictly read-only live SQL validation & LLM auto-repair loop:
 *  1. Verifies the statement is read-only (SELECT / WITH ... SELECT).
 *  2. Neutralizes :binds -> NULL and runs wrapped with ROWNUM <= 25 (fallback FETCH FIRST 25 ROWS ONLY).
 *  3. On Oracle ORA-* errors, fetches live ALL_TAB_COLUMNS for referenced tables and asks the LLM to repair it
 *     for up to `maxAttempts` iterations.
 */
export async function validateAndRepairSql(opts: {
  ctx: vscode.ExtensionContext;
  conn: Connection;
  sql: string;
  manager: ConnectionManager;
  schema: SchemaService;
  log: Logger;
  maxAttempts?: number;
  requestModel?: vscode.LanguageModelChat;
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
}): Promise<ValidateRepairResult> {
  const maxAttempts = Math.max(1, Math.min(5, opts.maxAttempts ?? settings.aiMaxRepairAttempts));
  let currentSql = opts.sql.trim();
  const attempts: RepairAttempt[] = [];

  if (!isReadOnlySql(currentSql)) {
    return {
      ok: false,
      sql: currentSql,
      repaired: false,
      attempts,
      warnings: [],
      error: 'Validation refused: only read-only SELECT / WITH statements can be validated against Fusion.'
    };
  }

  const client = await opts.manager.clientFor(opts.conn, true);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new FusionError('cancelled', 'Cancelled.');
    }
    if (!isReadOnlySql(currentSql)) {
      return {
        ok: false,
        sql: currentSql,
        repaired: attempt > 1,
        attempts,
        warnings: [],
        error: 'Auto-repair produced a non-read-only statement; aborted for safety.'
      };
    }

    opts.onStatus?.(`Validating SQL (attempt ${attempt}/${maxAttempts}) on ${opts.conn.name}…`);
    const neutralized = neutralizeBindsForValidation(currentSql);
    try {
      let page;
      try {
        page = await client.runSql(wrapValidationQuery(neutralized, 'rownum', 25), { limit: 25, signal: opts.signal });
      } catch (e) {
        if (e instanceof FusionError && e.kind === 'oracle' && /ORA-00918|ORA-00957/.test(e.message)) {
          page = await client.runSql(wrapValidationQuery(neutralized, 'fetch', 25), { limit: 25, signal: opts.signal });
        } else {
          throw e;
        }
      }
      attempts.push({ attempt, sql: currentSql });
      return {
        ok: true,
        sql: currentSql,
        repaired: attempt > 1,
        attempts,
        sampleRowCount: page.rows.length,
        columns: page.columns,
        warnings: analyzeFusionSql(currentSql)
      };
    } catch (e) {
      if (e instanceof FusionError && (e.kind === 'cancelled' || e.kind === 'auth' || e.kind === 'sso' || e.kind === 'network' || e.kind === 'tls' || e.kind === 'runtime-missing')) {
        throw e;
      }
      const errMsg = e instanceof FusionError ? e.message : errorMessage(e);
      attempts.push({ attempt, sql: currentSql, error: errMsg });
      opts.log.info(`Validation attempt ${attempt} failed: ${errMsg}`);

      if (attempt >= maxAttempts) {
        return {
          ok: false,
          sql: currentSql,
          repaired: attempt > 1,
          attempts,
          warnings: analyzeFusionSql(currentSql),
          error: errMsg
        };
      }

      // Gather real ALL_TAB_COLUMNS for tables in the failing SQL so the LLM fixes exact column names.
      opts.onStatus?.(`Attempt ${attempt} failed (${errMsg.slice(0, 60)}); fetching table columns & repairing…`);
      const tables = [...new Set(tablesInStatement(currentSql).values())].slice(0, 8);
      const schemaHints: string[] = [];
      for (const t of tables) {
        const cols = await Promise.race([opts.schema.columns(opts.conn, t), new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]);
        if (cols?.length) {
          schemaHints.push(`${t}: ${cols.map((c) => `${c.name.toLowerCase()} (${c.type})`).join(', ')}`);
        }
      }

      const repairPrompt = [
        'Fix the following Oracle Fusion Cloud SQL statement so it executes cleanly in Oracle BI Publisher.',
        'RULES:',
        '- Return ONLY ONE read-only SELECT or WITH ... SELECT statement inside a single ```sql ... ``` fenced block.',
        '- Never use DML, DDL, PL/SQL, or trailing semicolons.',
        '- Use ONLY real column names from the provided schema when fixing ORA-00904 / ORA-00918 / ORA-00942 errors.',
        opts.conn.fusionContext ? `\nFUSION CONTEXT:\n${JSON.stringify(opts.conn.fusionContext)}` : '',
        schemaHints.length ? `\nACTUAL TABLE COLUMNS (from ALL_TAB_COLUMNS):\n${schemaHints.join('\n')}` : '',
        `\nORACLE ERROR:\n${errMsg}`,
        `\nFAILING SQL:\n${currentSql}`
      ]
        .filter(Boolean)
        .join('\n');

      try {
        const llmRes = await completePrompt(opts.ctx, repairPrompt, { requestModel: opts.requestModel, signal: opts.signal });
        const candidate = extractSqlBlock(llmRes.text);
        if (!candidate || candidate.trim() === currentSql.trim()) {
          return {
            ok: false,
            sql: currentSql,
            repaired: attempt > 1,
            attempts,
            warnings: analyzeFusionSql(currentSql),
            error: errMsg
          };
        }
        currentSql = candidate.trim();
      } catch (llmErr) {
        return {
          ok: false,
          sql: currentSql,
          repaired: attempt > 1,
          attempts,
          warnings: analyzeFusionSql(currentSql),
          error: `${errMsg} (Auto-repair unavailable: ${errorMessage(llmErr)})`
        };
      }
    }
  }

  return { ok: false, sql: currentSql, repaired: false, attempts, warnings: analyzeFusionSql(currentSql), error: 'Validation did not complete.' };
}
