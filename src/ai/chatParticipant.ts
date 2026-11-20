import * as vscode from 'vscode';
import { Connection, FusionContext } from '../model';
import { ConnectionStore } from '../connections/ConnectionStore';
import { ConnectionManager } from '../connections/ConnectionManager';
import { SchemaService } from '../schema/SchemaService';
import { ResultsView } from '../results/ResultsView';
import { tablesInStatement } from '../sql/completion';
import { FUSION_TABLE_MAP } from '../sql/fusionCatalog';
import { statementAt } from '../sql/lexer';
import { Logger } from '../fusion/types';
import { analyzeFusionSql, extractSqlBlock } from './sqlAnalyzer';
import { streamPrompt } from './llmClient';
import { validateAndRepairSql } from './repair';

export const KEY_AI_RULES = 'fusionSqlDev.aiRules';

const SYSTEM_PROMPT = `You are "Fusion SQL", an expert Oracle Fusion Cloud (HCM, Financials/ERP, SCM, Procurement, Projects) SQL engineer working inside VS Code.
The user runs queries against a Fusion pod through Oracle BI Publisher. Follow these rules strictly:

OUTPUT RULES
- Produce Oracle SQL (19c/23ai syntax) for ONE read-only statement: SELECT or WITH ... SELECT. Never produce INSERT/UPDATE/DELETE/MERGE/DDL/PL-SQL: BI Publisher cannot run them.
- No trailing semicolon. No SQL*Plus commands. Bind variables may be written as :name (the tool asks for values).
- Put the final SQL in a single fenced block: \`\`\`sql ... \`\`\`. Explain briefly (what it returns, any assumption) before or after the block.
- Prefer ANSI joins, explicit column lists (no SELECT * on large tables), meaningful aliases, and add FETCH FIRST n ROWS ONLY when exploring.

FUSION KNOWLEDGE
- Date-effective tables (suffix _F, and _M tables such as PER_ALL_ASSIGNMENTS_M) need: TRUNC(SYSDATE) BETWEEN x.effective_start_date AND x.effective_end_date. For _M assignments also filter effective_latest_change = 'Y', assignment_type = 'E' (employee), primary_flag = 'Y' when you want the primary employee assignment.
- Translated tables: _B (base) joins to _TL on the id plus tl.language = USERENV('LANG') (or 'US'). Views ending _VL / _V already resolve translations.
- Multi-org tables (_ALL) are filtered by org_id/business unit (BU_ID); mention it when relevant.
- Person name: PER_PERSON_NAMES_F with name_type = 'GLOBAL'. Lookups: FND_LOOKUP_VALUES (lookup_type, lookup_code, meaning, language, enabled_flag and active dates).
- Typical chains: GL_JE_BATCHES > GL_JE_HEADERS > GL_JE_LINES > GL_CODE_COMBINATIONS; AP_INVOICES_ALL > AP_INVOICE_LINES_ALL > AP_INVOICE_DISTRIBUTIONS_ALL; PO_HEADERS_ALL > PO_LINES_ALL > PO_LINE_LOCATIONS_ALL > PO_DISTRIBUTIONS_ALL; HZ_PARTIES > HZ_CUST_ACCOUNTS > HZ_CUST_ACCT_SITES_ALL.
- If you are not certain a column exists, say so and tell the user to verify with: DESC <table>  (supported in this worksheet).
- Never invent table names. If a needed table is unknown, say what you would look for and how to search (Schema view, or SELECT table_name FROM all_tables WHERE table_name LIKE '%KEYWORD%').

STYLE: concise, practical, no marketing language.`;

export function formatFusionContext(fc?: FusionContext): string {
  if (!fc) {
    return '';
  }
  const lines: string[] = [];
  if (fc.coaSegments) {
    lines.push(`- Chart of Accounts (GL_CODE_COMBINATIONS): ${fc.coaSegments}`);
  }
  if (fc.ledger) {
    lines.push(`- Ledger: ${fc.ledger}`);
  }
  if (fc.businessUnit) {
    lines.push(`- Business Unit: ${fc.businessUnit}`);
  }
  if (fc.calendar) {
    lines.push(`- Calendar / Period: ${fc.calendar}`);
  }
  if (fc.notes) {
    lines.push(`- Pod Notes: ${fc.notes}`);
  }
  return lines.join('\n');
}

export function getAiRules(ctx: vscode.ExtensionContext): string[] {
  return ctx.globalState.get<string[]>(KEY_AI_RULES, []);
}

export function registerChatParticipant(
  ctx: vscode.ExtensionContext,
  store: ConnectionStore,
  manager: ConnectionManager,
  schema: SchemaService,
  results: ResultsView,
  log: Logger
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _chatCtx, stream, token) => {
    const editor =
      vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'sql'
        ? vscode.window.activeTextEditor
        : vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
    let currentSql = '';
    if (editor) {
      currentSql = !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : (statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active))?.text ?? '');
    }
    const lastError = results
      .all()
      .reverse()
      .find((r) => r.status === 'error' && r.error);
    const conn: Connection | undefined = store.active;
    const command = request.command ?? 'write';

    // /validate: live read-only validation + auto-repair right inside @fusion chat
    if (command === 'validate') {
      const targetSql = extractSqlBlock(request.prompt) || request.prompt.trim() || currentSql;
      if (!targetSql) {
        stream.markdown('Open a SQL worksheet with a query (or paste a `SELECT` statement) to validate.');
        return;
      }
      if (!conn) {
        stream.markdown('Select an active Fusion connection first to validate SQL live.');
        return;
      }
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      try {
        const res = await validateAndRepairSql({
          ctx,
          conn,
          sql: targetSql,
          manager,
          schema,
          log,
          requestModel: request.model,
          signal: ac.signal,
          onStatus: (m) => stream.markdown(`_${m}_\n\n`)
        });
        if (res.ok) {
          stream.markdown(
            `${res.repaired ? `**Auto-repaired and validated** in ${res.attempts.length} attempt(s)` : '**Validated successfully**'} on **${conn.name}** (${res.sampleRowCount ?? 0} sample row(s) returned).\n\n\`\`\`sql\n${res.sql}\n\`\`\`\n`
          );
        } else {
          stream.markdown(`**Validation failed** after ${res.attempts.length} attempt(s): \`${res.error ?? 'Unknown error'}\`\n\n\`\`\`sql\n${res.sql}\n\`\`\`\n`);
        }
        if (res.warnings.length > 0) {
          stream.markdown('\n**Safety & performance notes:**\n' + res.warnings.map((w) => `- **${w.code}:** ${w.message} _(${w.suggestion})_`).join('\n') + '\n');
        }
        stream.button({ command: 'fusionSqlDev.insertSql', title: 'Insert into worksheet', arguments: [res.sql] });
        stream.button({ command: 'fusionSqlDev.runSqlText', title: 'Run now', arguments: [res.sql] });
      } catch (e) {
        stream.markdown(`Validation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    const tables = new Set<string>();
    for (const t of tablesInStatement(currentSql).values()) {
      tables.add(t);
    }
    for (const m of request.prompt.toUpperCase().matchAll(/\b[A-Z][A-Z0-9_$#]{3,}\b/g)) {
      if (FUSION_TABLE_MAP.has(m[0]) || (conn && schema.cachedAll(conn.id)?.some((o) => o.name === m[0]))) {
        tables.add(m[0]);
      }
    }
    const schemaLines: string[] = [];
    for (const t of [...tables].slice(0, 8)) {
      let cols = conn ? schema.cachedColumns(conn.id, t) : undefined;
      if (!cols && conn) {
        cols = await Promise.race([schema.columns(conn, t), new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500))]);
      }
      if (cols?.length) {
        schemaLines.push(`${t}(${cols.map((c) => `${c.name.toLowerCase()} ${c.type}`).join(', ')})`);
      } else if (FUSION_TABLE_MAP.has(t)) {
        schemaLines.push(`${t}: ${FUSION_TABLE_MAP.get(t)!.desc} (columns not loaded)`);
      }
    }

    const task: Record<string, string> = {
      write: 'Write the SQL the user describes.',
      explain: 'Explain what the SQL below does, step by step, and point out any correctness or performance risks. Do not rewrite it unless asked.',
      fix: 'Fix the SQL below. If a database error is given, explain the cause in one or two sentences and return the corrected statement.',
      optimize: 'Review the SQL below for performance on Oracle Fusion (index-friendly predicates, date-effective filters, unnecessary DISTINCT/functions on columns, row limiting) and return an optimized version with the reasons.',
      tables: 'Suggest which Fusion tables/views are relevant to the topic, how they join, and the key columns. Give an example query.'
    };

    const fusionCtxText = formatFusionContext(conn?.fusionContext);
    const rules = getAiRules(ctx);

    const parts = [
      `TASK: ${task[command] ?? task.write}`,
      conn ? `\nCONNECTION: ${conn.name} (${conn.environment})` : '',
      fusionCtxText ? `\nPOD FUSION CONTEXT:\n${fusionCtxText}` : '',
      rules.length ? `\nREMEMBERED USER SQL RULES:\n${rules.map((r) => `- ${r}`).join('\n')}` : '',
      currentSql ? `\nSQL IN EDITOR:\n${currentSql}` : '',
      lastError && (command === 'fix' || /error|fail|ora-/i.test(request.prompt)) ? `\nLAST ERROR:\n${lastError.error!.message}\nFOR SQL:\n${lastError.sql}` : '',
      schemaLines.length ? `\nKNOWN SCHEMA:\n${schemaLines.join('\n')}` : '',
      `\nUSER REQUEST:\n${request.prompt || '(see task)'}`
    ].filter(Boolean);

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());

    try {
      const res = await streamPrompt(ctx, parts.join('\n'), (chunk) => stream.markdown(chunk), {
        requestModel: request.model,
        systemPrompt: SYSTEM_PROMPT,
        token,
        signal: ac.signal
      });
      const sql = extractSqlBlock(res.text);
      if (sql) {
        const warnings = analyzeFusionSql(sql);
        if (warnings.length > 0) {
          stream.markdown(
            '\n\n---\n**Fusion SQL Safety Checks:**\n' +
              warnings.map((w) => `- ${w.severity === 'warning' ? '⚠️' : 'ℹ️'} **${w.code}**: ${w.message} _${w.suggestion}_`).join('\n') +
              '\n'
          );
        }
        stream.button({ command: 'fusionSqlDev.insertSql', title: 'Insert into worksheet', arguments: [sql] });
        stream.button({ command: 'fusionSqlDev.runSqlText', title: 'Run now', arguments: [sql] });
        stream.button({ command: 'fusionSqlDev.validateAndRepairSql', title: 'Validate & Auto-Repair', arguments: [sql] });
      }
    } catch (e) {
      log.warn(`Chat request failed: ${e instanceof Error ? e.message : String(e)}`);
      stream.markdown(`The language model request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('fusion-sql-dev.fusion', handler);
  participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
  return participant;
}
